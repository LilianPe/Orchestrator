import { describe, expect, it } from 'vitest';
import { oneAtATime } from './one-at-a-time.js';

describe('one send at a time (ORC-494)', () => {
  it('sends once on a double click: the button stays disabled until the server answers (ORC-494)', async () => {
    let answer!: (kept: boolean) => void;
    const sent: string[] = [];
    const busy: boolean[] = [];
    const enter = oneAtATime((on) => busy.push(on));
    const click = () => enter(() => { sent.push('defect'); return new Promise<boolean>((r) => { answer = r; }); });
    click();
    click();
    expect(sent).toEqual(['defect']);
    expect(busy).toEqual([true]);
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(busy).toEqual([true, false]);
    click();
    expect(sent).toEqual(['defect', 'defect']);
  });

  it('frees the button when the server refuses or fails, so what was typed can be sent again (ORC-494)', async () => {
    const busy: boolean[] = [];
    let sent = 0;
    const enter = oneAtATime((on) => busy.push(on));
    const settle = () => new Promise((r) => setTimeout(r, 0));
    for (const answer of [() => Promise.resolve(false), () => Promise.reject(new Error('offline')), () => { throw new Error('thrown'); }]) {
      enter(() => { sent++; return answer(); });
      await settle();
    }
    expect(sent).toBe(3);
    expect(busy).toEqual([true, false, true, false, true, false]);
  });
});
