import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { approvalNotice, Maturity } from './Maturity.js';
import type { MaturityCardView } from './types.js';
import { MAIN_UNCHECKED } from '../../src/core/maturity.js';

const card = (patch: Partial<MaturityCardView> = {}): MaturityCardView => ({ projectId: 'p', key: 'stack', title: 'Stack', value: 'TypeScript (package.json)', detectedAt: 1_000, ...patch });
const render = (cards: MaturityCardView[], notice?: string) => renderToStaticMarkup(createElement(Maturity, { cards, onApprove: async () => undefined, notice }));

describe('the maturity cards page (ORC-410)', () => {
  it('shows each card of each project, its value, and a button to approve one not approved yet', () => {
    const html = render([card(), card({ key: 'untested', title: 'Areas without tests', value: 'src/a\nsrc/b' }), card({ projectId: 'q' })]);
    expect(html).toContain('<h2>p</h2>');
    expect(html).toContain('<h2>q</h2>');
    expect(html).toContain('TypeScript (package.json)');
    expect(html).toContain('src/a\nsrc/b');
    expect(html.match(/>Approve</g)).toHaveLength(3);
  });

  it('says who approved a card, and when, in place of the button', () => {
    const html = render([card({ approvedBy: 'github:armand', approvedAt: 5_000 })]);
    expect(html).toContain('Approved by github:armand');
    expect(html).not.toContain('>Approve<');
  });

  it('points to factory init when no project has cards, and shows the notice of the last approval', () => {
    expect(render([])).toContain('factory init');
    expect(render([card()], 'Card approved.')).toContain('Card approved.');
  });

  it('offers no approval of the main card while it says not checked yet, and says how to check it (ORC-437)', () => {
    const html = render([card({ key: 'main', title: 'main green or red', value: MAIN_UNCHECKED })]);
    expect(html).not.toContain('>Approve<');
    expect(html).toContain('factory dry-run p');
  });

  it('says, after an approval, that the card was approved already, by whom and when: that first approval stands (ORC-454)', () => {
    const notice = approvalNotice({ already: true, card: card({ approvedBy: 'github:armand', approvedAt: Date.UTC(2026, 10, 2, 9) }) }, card());
    expect(notice).toMatch(/^Stack was already approved by github:armand on .*2026.*: that approval stands\.$/);
    expect(approvalNotice({ card: card({ approvedBy: 'dashboard:local', approvedAt: 5 }) }, card())).toBe('Stack approved.');
    expect(approvalNotice({}, card())).toBe('Stack approved.');
  });
});
