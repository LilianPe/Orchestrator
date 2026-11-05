import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync, zstdDecompressSync } from 'node:zlib';
import { cli, enabled, image, TOKEN } from './helpers.js';

/**
 * Isolation n° 7, the files of the image (ORC-203): `history` and `inspect` (isolation-07-secrets.test.ts)
 * show only commands and config. This reads what each layer holds, a file a later layer deleted included.
 */

/**
 * In the files of the public node image, so in any image on top of it (measured with `grep` on
 * node:24.22.1-bookworm-slim): Unicode names in libunistring, data in the node binary. Exact strings, not a
 * pattern: anything else fails, and a node bump that changes them says so here.
 */
const BASE_IMAGE_LOOKALIKES = new Set(['AKIAISLANDISSHARITAL', 'AKIA1JDQACQCATIAFGDQ', 'AKIASACKAKUARD0DSABI', 'AKIASAEKAKMAUEBQQIQ3', 'AKIATYCVCABIAZBAXI2A']);

/** A blob of `save`, a layer or a manifest, unpacked: its bytes hold every file of the layer, whole and in the clear. */
function layerBytes(blob: Buffer): Buffer {
  if (blob.length >= 4 && blob[0] === 0x1f && blob[1] === 0x8b) return gunzipSync(blob);
  if (blob.length >= 4 && blob.readUInt32LE(0) === 0xfd2fb528) return zstdDecompressSync(blob);
  return blob;
}

/** By overlapping windows: a layer can be larger than the longest string V8 holds. */
function tokensIn(bytes: Buffer): string[] {
  const WINDOW = 64 * 1024 * 1024;
  const found = new Set<string>();
  for (let at = 0; at < bytes.length; at += WINDOW) {
    for (const [m] of bytes.toString('latin1', at, at + WINDOW + 256).matchAll(new RegExp(TOKEN.source, 'g'))) if (!BASE_IMAGE_LOOKALIKES.has(m)) found.add(m);
  }
  return [...found];
}

describe('the search of a layer', () => {
  it('finds a token in a compressed layer, and only the exact lookalikes pass', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    expect(tokensIn(layerBytes(gzipSync(`x ${token} y AKIAISLANDISSHARITAL AKIAISLANDISSHARITAX`)))).toEqual([token, 'AKIAISLANDISSHARITAX']);
  });
});

// The image built here: the public node image the other isolation tests default to is not ours to answer for.
describe.skipIf(!enabled || !process.env['FACTORY_RUNNER_IMAGE'])(`no secret in the layers of ${image} (${cli}, isolation n° 7)`, () => {
  it('has no token in the files of any layer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-layers-'));
    try {
      execFileSync(cli, ['save', '-o', join(dir, 'image.tar'), image], { timeout: 300_000 });
      execFileSync('tar', ['-xf', 'image.tar'], { cwd: dir, timeout: 300_000 });
      rmSync(join(dir, 'image.tar'));
      const blobs = readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name));
      // A format this test cannot read would otherwise find nothing and pass.
      expect(blobs.filter((f) => statSync(f).size > 1024 * 1024).length, 'no layer found in the archive').toBeGreaterThan(0);
      const found = blobs.flatMap((f) => tokensIn(layerBytes(readFileSync(f))).map((m) => `${f}: ${m.slice(0, 12)}...`));
      expect(found).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
