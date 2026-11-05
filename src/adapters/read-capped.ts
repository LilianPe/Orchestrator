import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The first `cap` bytes of a plain file; undefined when there is none. Not following a link nor
 * waiting on a FIFO: for a file an agent could have replaced by either. `cut`: the file goes on past the cap.
 */
export function readCapped(path: string, cap: number): { text: string; cut: boolean } | 'not a file' | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'not a file';
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return 'not a file';
    const buf = Buffer.alloc(Math.min(st.size, cap));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.subarray(0, n).toString('utf8'), cut: st.size > cap };
  } catch {
    return 'not a file';
  } finally {
    closeSync(fd);
  }
}
