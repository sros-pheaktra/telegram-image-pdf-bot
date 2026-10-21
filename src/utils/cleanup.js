import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const TEMP_ROOT = path.join(os.tmpdir(), 'telegram-image-pdf-bot');

/** Ensure the temp root exists. */
export async function ensureTempRoot() {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
}

/** Delete a single file, ignoring "not found" and other errors. */
export async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Cleanup warning: could not delete temp file:', err.code || err.message);
    }
  }
}

/** Delete several files. */
export async function safeUnlinkAll(paths = []) {
  await Promise.all(paths.filter(Boolean).map(safeUnlink));
}

/** Remove leftover files from a previous run (called on startup). */
export async function purgeTempRoot() {
  try {
    await fs.rm(TEMP_ROOT, { recursive: true, force: true });
  } catch (err) {
    console.error('Cleanup warning: could not purge temp dir:', err.code || err.message);
  }
  await ensureTempRoot();
}
