import { describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../config/repo-config.js';
import { agentPolicy, allowConnect, allowRequest, stepPolicy, type EgressPolicy } from './levels.js';

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

  it('lets Claude Code refresh its OAuth token, and write nothing else to the auth hosts', () => {
    const claude = { level: 'claude-api' as const, allow: [] };
    expect(allowRequest(claude, 'console.anthropic.com', 'POST', '/v1/oauth/token').ok).toBe(true);
    expect(allowRequest(claude, 'platform.claude.com', 'POST', '/v1/oauth/token?x=1').ok).toBe(true);
    expect(allowRequest(claude, 'console.anthropic.com', 'POST', '/v1/other').ok).toBe(false);
    expect(allowRequest(claude, 'nodejs.org', 'GET', '/').ok).toBe(false);
    expect(allowRequest({ level: 'none', allow: [] }, 'console.anthropic.com', 'POST', '/v1/oauth/token').ok).toBe(false);
  });

  it('follows the level', () => {
    expect(allowRequest({ level: 'none', allow: [] }, 'registry.npmjs.org', 'GET', '/').ok).toBe(false);
    expect(allowRequest({ level: 'claude-api', allow: [] }, 'registry.npmjs.org', 'GET', '/').ok).toBe(false);
    expect(allowRequest({ level: 'full', allow: [] }, 'example.com', 'POST', '/').ok).toBe(true);
  });
});
