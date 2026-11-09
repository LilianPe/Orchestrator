import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { shellLine, TakenOver } from './TakeOver.js';

const ticket = { projectId: 'p', ticketId: 'REL-1', title: 'Export' };
const page = (props: Partial<Parameters<typeof TakenOver>[0]> = {}) =>
  renderToStaticMarkup(createElement(TakenOver, { ticket, onShell: () => undefined, onBundle: () => undefined, ...props }));

describe('a ticket taken over (ORC-234)', () => {
  it('says the work goes on in its container or comes back as a bundle the factory checks, never on the server', () => {
    const html = page();
    expect(html).toContain('REL-1');
    expect(html).toContain('container');
    expect(html).toContain('git bundle create');
    expect(html).toMatch(/<button[^>]*>Shell in its container<\/button>/);
    expect(html).toMatch(/<input[^>]*type="file"/);
  });

  it('shows the command of a shell in the container once asked, with what its environment needs', () => {
    const html = page({ shell: { command: ['docker', 'exec', '-i', '-w', '/work', 'c1', 'sh', '-i'], env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' } } });
    expect(html).toContain('DOCKER_HOST=unix:///run/user/1000/docker.sock docker exec -i -w /work c1 sh -i');
  });

  it('quotes what a shell would split', () => {
    expect(shellLine({ command: ['a b', "it's"], env: {} })).toBe(String.raw`'a b' 'it'\''s'`);
  });

  it('shows the answer to the last action', () => {
    expect(page({ notice: 'REL-1 is not taken over' })).toContain('REL-1 is not taken over');
  });
});
