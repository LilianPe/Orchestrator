import { describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../config/repo-config.js';
import { allowConnect, allowRequest, stepPolicy, type EgressPolicy } from './levels.js';

const repo = (yaml?: string) => parseRepoConfig(yaml);
const limited: EgressPolicy = { level: 'limited', allow: [] };

describe('stepPolicy', () => {
  it('is limited by default, the repository hosts only for custom', () => {
    expect(stepPolicy(repo())).toEqual(limited);
    expect(stepPolicy(repo('network: { level: limited, allow: [docs.exemple.com] }\n'))).toEqual(limited);
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

  it('never tunnels a host with a write API: plain HTTP through the proxy, which sees the method', () => {
    for (const host of ['github.com', 'api.github.com', 'registry.npmjs.org', 'pypi.org']) {
      expect(allowConnect(limited, host)).toEqual({ ok: false, reason: expect.stringMatching(/http:\/\//) as string });
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
    expect(allowRequest(limited, 'github.com', 'GET', '/o/r.git/info/refs?service=git-receive-pack').ok).toBe(false);
    expect(allowRequest(limited, 'registry.npmjs.org', 'PUT', '/is-number').ok).toBe(false);
  });

  it('lets git fetch over smart HTTP, a POST to git-upload-pack on github.com only', () => {
    expect(allowRequest(limited, 'github.com', 'POST', '/o/r.git/git-upload-pack').ok).toBe(true);
    expect(allowRequest(limited, 'api.github.com', 'POST', '/o/r.git/git-upload-pack').ok).toBe(false);
  });

  it('keeps every method for the Claude API, the read methods elsewhere', () => {
    expect(allowRequest(limited, 'api.anthropic.com', 'POST', '/v1/messages').ok).toBe(true);
    expect(allowRequest({ level: 'limited', allow: ['docs.exemple.com'] }, 'docs.exemple.com', 'OPTIONS', '/').ok).toBe(true);
    expect(allowRequest({ level: 'limited', allow: ['docs.exemple.com'] }, 'docs.exemple.com', 'DELETE', '/').ok).toBe(false);
  });

  it('follows the level', () => {
    expect(allowRequest({ level: 'none', allow: [] }, 'registry.npmjs.org', 'GET', '/').ok).toBe(false);
    expect(allowRequest({ level: 'claude-api', allow: [] }, 'registry.npmjs.org', 'GET', '/').ok).toBe(false);
    expect(allowRequest({ level: 'full', allow: [] }, 'example.com', 'POST', '/').ok).toBe(true);
  });
});
