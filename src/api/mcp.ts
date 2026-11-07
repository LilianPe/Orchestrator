import { z } from 'zod';
import { saveAgentOutput, agentOutputSchema, parseAgentOutput } from '../core/agent-output.js';
import type { RunRecord, Store } from '../store/types.js';
import { PRODUCT_NAME } from '../product.js';

/**
 * The factory's MCP server (ORC-188): Streamable HTTP, JSON answers only, one message per request
 * (no batch, no SSE: no tool streams nor calls back). Served at `POST /agent/mcp`, behind the run token.
 */
export interface McpDeps {
  store: Pick<Store, 'setMeta'>;
  /** The `/agent/ask` effect: an elicitation in Linear, the ticket blocked. */
  ask: (run: RunRecord, text: string) => Promise<void>;
}

type Rpc = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

/** Newest first: a client asking for one of these gets it back, any other gets the newest (MCP lifecycle). */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const TOOLS = [
  {
    name: 'submit_result',
    description: 'Hands the run\'s result to the factory, last. Only this result is read: a run without a valid result fails. A second submission replaces the first.',
    inputSchema: z.toJSONSchema(agentOutputSchema),
  },
  {
    name: 'ask',
    description: 'Asks a human a question in Linear and blocks the ticket until they answer.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
  },
];

const text = (t: string, isError?: true) => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) });

async function callTool(name: unknown, args: Record<string, unknown>, run: RunRecord, d: McpDeps) {
  if (name === 'submit_result') {
    const parsed = parseAgentOutput(args);
    if (!parsed.ok) return text(`Result refused, to fix: ${parsed.error}`, true);
    await saveAgentOutput(d.store, run.id, parsed.output);
    return text('Result recorded.');
  }
  if (name === 'ask') {
    if (typeof args['text'] !== 'string' || !args['text']) return text('text: required', true);
    await d.ask(run, args['text']);
    return text('Question asked: the ticket waits for the answer.');
  }
  return undefined;
}

/** One JSON-RPC message in, its answer out; `undefined` for a notification (HTTP 202, no body). */
export async function handleMcp(msg: unknown, run: RunRecord, d: McpDeps): Promise<Rpc | undefined> {
  const m = (msg ?? {}) as { id?: string | number; method?: unknown; params?: Record<string, unknown> };
  if (m.id === undefined) return undefined;
  const ok = (result: unknown): Rpc => ({ jsonrpc: '2.0', id: m.id!, result });
  const fail = (code: number, message: string): Rpc => ({ jsonrpc: '2.0', id: m.id!, error: { code, message } });
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.['protocolVersion'];
      const protocolVersion = VERSIONS.find((v) => v === asked) ?? VERSIONS[0];
      return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'factory', title: PRODUCT_NAME, version: '1' } });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const args = m.params?.['arguments'];
      const result = await callTool(m.params?.['name'], args && typeof args === 'object' ? (args as Record<string, unknown>) : {}, run, d);
      return result ? ok(result) : fail(-32602, `Unknown tool: ${String(m.params?.['name'])}`);
    }
    default:
      return fail(-32601, `Method not found: ${String(m.method)}`);
  }
}
