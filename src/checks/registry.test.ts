import { describe, expect, it } from 'vitest';
import { HttpPackageRegistry } from './registry.js';

type Route = { status: number; body?: unknown } | Error;

function stubFetch(routes: Record<string, Route>): { fetch: typeof fetch; calls: { url: string; accept: string | null }[] } {
  const calls: { url: string; accept: string | null }[] = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, accept: new Headers(init?.headers).get('accept') });
    const route = routes[url] ?? { status: 404 };
    if (route instanceof Error) throw route;
    return new Response(typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {}), { status: route.status });
  };
  return { fetch: fetchStub as typeof fetch, calls };
}

describe('HttpPackageRegistry', () => {
  it('asks npm and PyPI at their URLs, through the injected fetch and base URLs', async () => {
    const { fetch, calls } = stubFetch({
      'http://proxy.test/npm/@types%2fnode': { status: 200, body: { name: '@types/node', versions: { '24.0.0': {} } } },
      'http://proxy.test/npm/left-pad': { status: 200, body: { name: 'left-pad', versions: { '1.3.0': {} } } },
      'http://proxy.test/pypi/pypi/typing-extensions/json': { status: 200, body: { info: {} } },
    });
    const reg = new HttpPackageRegistry({ fetch, npmBaseUrl: 'http://proxy.test/npm/', pypiBaseUrl: 'http://proxy.test/pypi' });
    expect(await reg.lookup('npm', '@types/node')).toEqual({ status: 'found' });
    expect(await reg.lookup('npm', 'left-pad')).toEqual({ status: 'found' });
    expect(await reg.lookup('pypi', 'typing-extensions')).toEqual({ status: 'found' });
    expect(await reg.lookup('pypi', 'reqeusts')).toEqual({ status: 'missing' });
    expect(calls.map((c) => c.accept)).toEqual(['application/vnd.npm.install-v1+json', 'application/vnd.npm.install-v1+json', 'application/json', 'application/json']);
  });

  it('uses the public registries by default', () => {
    const reg = new HttpPackageRegistry({ fetch: stubFetch({}).fetch });
    expect(reg.url('npm', '@scope/pkg')).toBe('https://registry.npmjs.org/@scope%2fpkg');
    expect(reg.url('pypi', 'requests')).toBe('https://pypi.org/pypi/requests/json');
  });

  it('treats an npm document with no version as missing', async () => {
    const { fetch } = stubFetch({ 'https://registry.npmjs.org/gone': { status: 200, body: { name: 'gone', time: { unpublished: {} } } } });
    expect(await new HttpPackageRegistry({ fetch }).lookup('npm', 'gone')).toEqual({ status: 'missing' });
  });

  it('answers unknown, with the reason, on a network error, a server error or a body that is not JSON', async () => {
    const { fetch } = stubFetch({
      'https://registry.npmjs.org/a': new TypeError('fetch failed'),
      'https://registry.npmjs.org/b': { status: 503 },
      'https://pypi.org/pypi/c/json': { status: 200, body: '<html>' },
    });
    const reg = new HttpPackageRegistry({ fetch });
    expect(await reg.lookup('npm', 'a')).toEqual({ status: 'unknown', reason: 'https://registry.npmjs.org/a: fetch failed' });
    expect(await reg.lookup('npm', 'b')).toEqual({ status: 'unknown', reason: 'https://registry.npmjs.org/b: HTTP 503' });
    expect(await reg.lookup('pypi', 'c')).toEqual({ status: 'unknown', reason: 'https://pypi.org/pypi/c/json: response is not JSON' });
  });

  it('cancels the body of a 404 or an error response instead of leaving the connection open', async () => {
    const cancelled: string[] = [];
    const fetchStub = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      const body = new ReadableStream({ cancel: () => void cancelled.push(url) });
      return new Response(body, { status: url.endsWith('/missing') ? 404 : 500 });
    };
    const reg = new HttpPackageRegistry({ fetch: fetchStub as typeof fetch });
    expect(await reg.lookup('npm', 'missing')).toEqual({ status: 'missing' });
    expect(await reg.lookup('npm', 'broken')).toMatchObject({ status: 'unknown' });
    expect(cancelled).toEqual(['https://registry.npmjs.org/missing', 'https://registry.npmjs.org/broken']);
  });
});
