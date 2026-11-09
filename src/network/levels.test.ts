import { describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../config/repo-config.js';
import { agentPolicy, allowConnect, allowRequest, CLAUDE_BODY_DEPTH, CLAUDE_BODY_VALUES, claudeBody, stepPolicy, type EgressPolicy } from './levels.js';

const repo = (yaml?: string) => parseRepoConfig(yaml);
const limited: EgressPolicy = { level: 'limited', allow: [] };

describe('stepPolicy', () => {
  it('lowercases the repository hosts, as the proxy matches them', () => {
    expect(stepPolicy(repo('network: { level: custom, allow: [Docs.Exemple.com] }\n')).allow).toEqual(['docs.exemple.com']);
  });

  it('is limited by default, the repository hosts only for custom', () => {
    expect(stepPolicy(repo())).toEqual(limited);
    // The schema refuses such a list; built by hand, it still opens nothing.
    expect(stepPolicy({ ...repo(), network: { level: 'limited', allow: ['docs.exemple.com'] } })).toEqual(limited);
    expect(stepPolicy(repo('network: { level: custom, allow: [docs.exemple.com] }\n'))).toEqual({ level: 'limited', allow: ['docs.exemple.com'] });
  });

  it('lets a step narrow the repository level, never widen it', () => {
    const custom = repo('network: { level: custom, allow: [docs.exemple.com] }\n');
    expect(stepPolicy(custom, 'claude-api')).toEqual({ level: 'claude-api', allow: [] });
    expect(stepPolicy(custom, 'none')).toEqual({ level: 'none', allow: [] });
    expect(stepPolicy(repo('network: { level: none }\n'), 'limited')).toEqual({ level: 'none', allow: [] });
  });

  it('refuses full: it is the setup’s, never the agent’s', () => {
    expect(() => stepPolicy(repo(), 'full')).toThrow(/setup/);
  });
});

describe('agentPolicy (an agent run, ORC-209 C)', () => {
  it("is the repository's level, with its hosts for custom", () => {
    expect(agentPolicy(repo())).toEqual(limited);
    expect(agentPolicy(repo('network: { level: custom, allow: [docs.exemple.com] }\n'))).toEqual({ level: 'limited', allow: ['docs.exemple.com'] });
  });

  it('keeps the Claude API for a repository at none: the agent cannot run without it', () => {
    expect(agentPolicy(repo('network: { level: none }\n'))).toEqual({ level: 'claude-api', allow: [] });
  });

  it("narrows to the step's level: an AI review reaches the Claude API alone, whatever the repository allows (ORC-183)", () => {
    const review = agentPolicy(repo('network: { level: custom, allow: [docs.exemple.com] }\n'), 'claude-api');
    expect(review).toEqual({ level: 'claude-api', allow: [] });
    expect(allowConnect(review, 'api.anthropic.com').ok).toBe(true);
    for (const host of ['github.com', 'registry.npmjs.org', 'docs.exemple.com']) expect(allowConnect(review, host).ok, host).toBe(false);
    expect(agentPolicy(repo('network: { level: none }\n'), 'claude-api')).toEqual({ level: 'claude-api', allow: [] });
    expect(agentPolicy(repo(), 'limited')).toEqual(limited);
  });
});

describe('allowConnect (a TLS tunnel: the host only)', () => {
  it('lets nothing through at none, the Claude API alone at claude-api', () => {
    expect(allowConnect({ level: 'none', allow: [] }, 'api.anthropic.com').ok).toBe(false);
    expect(allowConnect({ level: 'claude-api', allow: [] }, 'api.anthropic.com').ok).toBe(true);
    expect(allowConnect({ level: 'claude-api', allow: [] }, 'nodejs.org').ok).toBe(false);
  });

  it('tunnels the Claude API, the doc and download hosts and the repository hosts at limited', () => {
    for (const host of ['api.anthropic.com', 'nodejs.org', 'developer.mozilla.org', 'files.pythonhosted.org', 'codeload.github.com']) {
      expect(allowConnect(limited, host)).toEqual({ ok: true });
    }
    expect(allowConnect({ level: 'limited', allow: ['docs.exemple.com'] }, 'docs.exemple.com').ok).toBe(true);
    expect(allowConnect(limited, 'docs.exemple.com')).toEqual({ ok: false, reason: expect.stringMatching(/not allowed/) as string });
  });

  it('opens GitHub and the registries too: the proxy decrypts them and checks each request', () => {
    for (const host of ['github.com', 'api.github.com', 'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org']) {
      expect(allowConnect(limited, host)).toEqual({ ok: true });
    }
  });

  it('refuses telemetry and IP literals, matches host names whatever their case', () => {
    expect(allowConnect(limited, 'statsig.anthropic.com').ok).toBe(false);
    expect(allowConnect(limited, '160.79.104.10').ok).toBe(false);
    expect(allowConnect(limited, 'API.Anthropic.com.').ok).toBe(true);
  });

  it('lets anything through at full', () => {
    expect(allowConnect({ level: 'full', allow: [] }, 'example.com').ok).toBe(true);
  });
});

describe('allowRequest (plain HTTP: the method and the path are seen)', () => {
  it('reads GitHub and the registries, never writes there', () => {
    expect(allowRequest(limited, 'github.com', 'GET', '/o/r.git/info/refs?service=git-upload-pack').ok).toBe(true);
    expect(allowRequest(limited, 'registry.npmjs.org', 'GET', '/is-number').ok).toBe(true);
    expect(allowRequest(limited, 'api.github.com', 'HEAD', '/repos/o/r').ok).toBe(true);
    expect(allowRequest(limited, 'api.github.com', 'POST', '/gists')).toEqual({ ok: false, reason: expect.stringMatching(/POST/) as string });
    expect(allowRequest(limited, 'github.com', 'POST', '/o/r.git/git-receive-pack').ok).toBe(false);
    // The advertisement of a push under any spelling GitHub would decode (ORC-125).
    expect(allowRequest(limited, 'github.com', 'GET', '/o/r.git/info/refs?service=git%2Dreceive%2Dpack').ok).toBe(false);
    expect(allowRequest(limited, 'github.com', 'GET', '/o/r.git/info/refs?SERVICE=GIT-RECEIVE-PACK').ok).toBe(false);
    expect(allowRequest(limited, 'github.com', 'GET', '/o/r.git/info/refs?service=git-receive-pack').ok).toBe(false);
    expect(allowRequest(limited, 'registry.npmjs.org', 'PUT', '/is-number').ok).toBe(false);
  });

  it('lets git fetch over smart HTTP, a POST to git-upload-pack on github.com only', () => {
    expect(allowRequest(limited, 'github.com', 'POST', '/o/r.git/git-upload-pack').ok).toBe(true);
    expect(allowRequest(limited, 'api.github.com', 'POST', '/o/r.git/git-upload-pack').ok).toBe(false);
  });

  it('lets through the Claude API only the calls Claude Code makes, at any level but none (ORC-337)', () => {
    for (const p of [limited, { level: 'claude-api' as const, allow: [] }]) {
      expect(allowRequest(p, 'api.anthropic.com', 'POST', '/v1/messages?beta=true').ok).toBe(true);
      expect(allowRequest(p, 'API.anthropic.com.', 'POST', '/v1/messages/count_tokens?beta=true').ok).toBe(true);
      expect(allowRequest(p, 'api.anthropic.com', 'GET', '/api/claude_code/settings').ok).toBe(true);
      expect(allowRequest(p, 'api.anthropic.com', 'GET', '/api/claude_code/policy_limits').ok).toBe(true);
    }
    const refused = [
      ['POST', '/v1/files'], ['GET', '/v1/files'], ['GET', '/v1/messages'], ['POST', '/v1/messages/batches'], ['POST', '/v1/messages/../files'],
      ['POST', '//v1/messages'], ['POST', '/api/event_logging/v2/batch'], ['POST', '/api/eval/sdk-x'], ['GET', '/api/claude_cli/bootstrap'], ['POST', '/api/claude_code/settings'],
    ];
    for (const [method, path] of refused) expect(allowRequest(limited, 'api.anthropic.com', method!, path!), `${method} ${path}`).toMatchObject({ ok: false, reason: expect.stringMatching(/not a call of Claude Code/) as string });
    expect(allowRequest({ level: 'none', allow: [] }, 'api.anthropic.com', 'POST', '/v1/messages').ok).toBe(false);
  });

  it('keeps the read methods elsewhere', () => {
    expect(allowRequest({ level: 'limited', allow: ['docs.exemple.com'] }, 'docs.exemple.com', 'OPTIONS', '/').ok).toBe(true);
    expect(allowRequest({ level: 'limited', allow: ['docs.exemple.com'] }, 'docs.exemple.com', 'DELETE', '/').ok).toBe(false);
  });

  it('refuses the OAuth refresh hosts: a sandbox holds no refresh token, its token is the proxy\'s (ORC-337)', () => {
    for (const p of [{ level: 'claude-api' as const, allow: [] }, limited]) {
      for (const host of ['console.anthropic.com', 'platform.claude.com']) {
        expect(allowConnect(p, host).ok).toBe(false);
        expect(allowRequest(p, host, 'POST', '/v1/oauth/token').ok).toBe(false);
      }
      expect(allowRequest(p, 'nodejs.org', 'POST', '/').ok).toBe(false);
    }
  });

  it('reads a model call\'s body: JSON, client tools only, no MCP server nor container (ORC-337)', () => {
    const v = (body: unknown) => claudeBody(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    expect(v({ model: 'm', messages: [] }).ok).toBe(true);
    expect(v({ tools: [{ name: 'Bash', input_schema: {} }, { name: 'R', type: 'custom', input_schema: {} }, { type: 'bash_20250124', name: 'bash' }, { type: 'text_editor_20250728', name: 'e' }, { type: 'computer_20250124', name: 'c' }, { type: 'memory_20250818', name: 'memory' }] }).ok).toBe(true);
    for (const type of ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825', 'mcp_toolset', 'tool_search_tool_regex_20251119', 'bash', 'bash_2025', 'custom_x', 7]) {
      expect(v({ tools: [{ type, name: 'x' }] }), String(type)).toMatchObject({ ok: false, reason: expect.stringMatching(/server tool/) as string });
    }
    expect(v({ mcp_servers: [] })).toMatchObject({ ok: false, reason: 'Claude API body refused: mcp_servers' });
    expect(v({ container: 'c' }).ok).toBe(false);
    expect(v({ tools: {} }).ok).toBe(false);
    expect(v({ tools: [null] }).ok).toBe(false);
    for (const bad of ['', 'nope', '[]', 'null', '"s"']) expect(v(bad).ok, bad).toBe(false);
  });

  it('refuses any content Anthropic would fetch by URL, wherever the block sits (ORC-337)', () => {
    const v = (body: unknown) => claudeBody(Buffer.from(JSON.stringify(body)));
    const user = (content: unknown) => ({ model: 'm', messages: [{ role: 'user', content }] });
    const image = (source: unknown) => ({ type: 'image', source });
    const inline = [
      'hi',
      [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      [image({ type: 'base64', media_type: 'image/png', data: 'AA==' })],
      [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }],
      [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }, image({ type: 'base64', media_type: 'image/png', data: 'AA==' })] }],
      // A tool call's input is the agent's own data: a `url` in it is fetched by no one.
      [{ type: 'tool_use', id: 't', name: 'WebFetch', input: { url: 'https://example.com' } }],
    ];
    for (const content of inline) expect(v(user(content)), JSON.stringify(content)).toMatchObject({ ok: true });
    expect(v({ model: 'm', system: [{ type: 'text', text: 'rules' }], messages: [] }).ok).toBe(true);
    const fetched: [unknown, RegExp][] = [
      [user([image({ type: 'url', url: 'https://attacker.example/a.png' })]), /image block sourced by url/],
      [user([{ type: 'document', source: { type: 'url', url: 'https://attacker.example/a.pdf' } }]), /document block sourced by url/],
      [user([{ type: 'document', source: { type: 'file', file_id: 'f' } }]), /sourced by file/],
      [user([{ type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'x' }] } }]), /sourced by content/],
      [user([image('https://attacker.example/a.png')]), /sourced by string/],
      [user([{ type: 'tool_result', tool_use_id: 't', content: [image({ type: 'url', url: 'https://attacker.example/a.png' })] }]), /image block sourced by url/],
      [user([{ type: 'search_result', source: 'https://attacker.example', title: 't', content: [{ type: 'text', text: 'x' }] }]), /search_result block sourced by string/],
      [user([{ type: 'text', text: 'x', citations: [{ type: 'web_search_result_location', url: 'https://attacker.example' }] }]), /cited by url/],
      [user([{ type: 'whatever', url: 'https://attacker.example' }]), /whatever block with a url/],
      [{ model: 'm', system: [{ type: 'text', text: 'x', citations: [{ url: 'https://attacker.example' }] }], messages: [] }, /cited by url/],
      [{ model: 'm', messages: {} }, /messages is not a list/],
      [user({ type: 'image' }), /content that is not a list/],
    ];
    for (const [body, reason] of fetched) expect(v(body), JSON.stringify(body)).toMatchObject({ ok: false, reason: expect.stringMatching(reason) as string });
  });

  it('hands on the call as it checked it: duplicate keys, which the API may read otherwise, are gone (ORC-337)', () => {
    const raw = '{"model":"m","tools":[{"type":"web_fetch_20250910","name":"f"}],"tools":[],"messages":[]}';
    const checked = claudeBody(Buffer.from(raw));
    expect(checked).toMatchObject({ ok: true });
    expect(checked.ok && checked.body.toString()).toBe('{"model":"m","tools":[],"messages":[]}');
    // The other way round, the last one read is the one checked.
    expect(claudeBody(Buffer.from('{"tools":[],"tools":[{"type":"web_fetch_20250910","name":"f"}]}')).ok).toBe(false);
    // Strings stay as sent: a thinking block's signature, unicode, escapes.
    const exact = { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'é \u2028 "q"', signature: 'sig/+=' }] }] };
    const again = claudeBody(Buffer.from(JSON.stringify(exact)));
    expect(again.ok && JSON.parse(again.body.toString())).toEqual(exact);
  });

  it('refuses a call nested past CLAUDE_BODY_DEPTH on its raw bytes, wherever, before any parse (ORC-337)', () => {
    const v = (raw: string) => claudeBody(Buffer.from(raw));
    const n = 200_000;
    const deep = `${'['.repeat(n)}${']'.repeat(n)}`;
    for (const raw of [
      `{"messages":[{"role":"user","content":${'[{"type":"tool_result","content":'.repeat(n)}"x"${'}]'.repeat(n)}}]}`,
      `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"B","input":${deep}}]}]}`,
      `{"messages":[],"whatever":${deep}}`,
    ]) expect(v(raw)).toEqual({ ok: false, reason: `Claude API body refused: nested deeper than ${CLAUDE_BODY_DEPTH}` });
    const at = (d: number) => `{"x":${'['.repeat(d - 1)}${']'.repeat(d - 1)}}`;
    expect(v(at(CLAUDE_BODY_DEPTH)).ok).toBe(true);
    expect(v(at(CLAUDE_BODY_DEPTH + 1)).ok).toBe(false);
    // In a string, a bracket is text; an escaped quote does not end the string, an escaped backslash does not escape it.
    expect(v(`{"x":"${'['.repeat(1000)}\\"${'{'.repeat(100)}","y":"a\\\\"}`).ok).toBe(true);
  });

  it('refuses a call of more than CLAUDE_BODY_VALUES values on its raw bytes, before any parse: a parse costs per value, empty objects 40 times their size (ORC-373)', () => {
    const v = (raw: string) => claudeBody(Buffer.from(raw));
    const reason = `Claude API body refused: more than ${CLAUDE_BODY_VALUES} values`;
    // Counted as the brackets and the commas: `{"messages":[` is 2, each `{}` 2 more, less the first one's comma.
    const objects = (n: number, tail = '') => `{"messages":[${'{},'.repeat(n - 1)}{}]${tail}}`;
    const at = CLAUDE_BODY_VALUES / 2 - 1;
    expect(v(objects(at, ',"x":0')).ok).toBe(true);
    expect(v(objects(at, ',"x":0,"y":0'))).toEqual({ ok: false, reason });
    expect(v(objects(at + 1))).toEqual({ ok: false, reason });
    for (const raw of [
      `{"messages":[{"role":"user","content":[{"type":"tool_use","id":"t","name":"B","input":[${'[],'.repeat(CLAUDE_BODY_VALUES)}[]]}]}]}`,
      `{"messages":[],"x":[${'0,'.repeat(CLAUDE_BODY_VALUES)}0]}`,
      `{"messages":[],"x":{${Array.from({ length: CLAUDE_BODY_VALUES }, (_, i) => `"k${i}":0`).join(',')}}}`,
    ]) expect(v(raw)).toEqual({ ok: false, reason });
    // In a string, a comma or a bracket is text.
    expect(v(`{"messages":[{"role":"user","content":"${',{['.repeat(CLAUDE_BODY_VALUES)}"}]}`).ok).toBe(true);
  });

  it('refuses what a parse and a serialisation would change: not UTF-8, a number past a double (ORC-337)', () => {
    expect(claudeBody(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d]))).toMatchObject({ ok: false, reason: 'Claude API body refused: not JSON in UTF-8' });
    for (const n of ['1e309', '-1e400', '9'.repeat(400), '1.5E+999']) expect(claudeBody(Buffer.from(`{"n":${n}}`)), n).toMatchObject({ ok: false, reason: expect.stringMatching(/out of range/) as string });
    for (const n of ['1e308', '-0.5', '12', '1E3']) expect(claudeBody(Buffer.from(`{"n":${n},"t":true,"f":false}`)).ok, n).toBe(true);
  });

  it('follows the level', () => {
    expect(allowRequest({ level: 'none', allow: [] }, 'registry.npmjs.org', 'GET', '/').ok).toBe(false);
    expect(allowRequest({ level: 'claude-api', allow: [] }, 'registry.npmjs.org', 'GET', '/').ok).toBe(false);
    expect(allowRequest({ level: 'full', allow: [] }, 'example.com', 'POST', '/').ok).toBe(true);
  });
});
