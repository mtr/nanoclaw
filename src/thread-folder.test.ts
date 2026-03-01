import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureThreadFolder, renameThreadFolder } from './thread-folder.js';

const TEST_BASE = path.join(os.tmpdir(), `nanoclaw-thread-test-${Date.now()}`);

afterEach(() => {
  fs.rmSync(TEST_BASE, { recursive: true, force: true });
});

describe('ensureThreadFolder', () => {
  it('creates the folder at base/group/slug', () => {
    const result = ensureThreadFolder(TEST_BASE, 'main', 'my-thread');
    expect(fs.existsSync(result)).toBe(true);
    expect(result).toBe(path.join(TEST_BASE, 'main', 'my-thread'));
  });

  it('is idempotent', () => {
    ensureThreadFolder(TEST_BASE, 'main', 'my-thread');
    const result = ensureThreadFolder(TEST_BASE, 'main', 'my-thread');
    expect(fs.existsSync(result)).toBe(true);
  });
});

describe('renameThreadFolder', () => {
  it('renames an existing folder', () => {
    const oldPath = ensureThreadFolder(TEST_BASE, 'main', 'old-slug');
    fs.writeFileSync(path.join(oldPath, 'test.md'), 'hello');

    const newPath = renameThreadFolder(
      TEST_BASE,
      'main',
      'old-slug',
      'new-slug',
    );
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(path.join(newPath, 'test.md'), 'utf-8')).toBe(
      'hello',
    );
  });

  it('creates new folder if old does not exist', () => {
    const newPath = renameThreadFolder(
      TEST_BASE,
      'main',
      'nonexistent',
      'new-slug',
    );
    expect(fs.existsSync(newPath)).toBe(true);
  });

  it('does nothing if old and new slug are the same', () => {
    const p = ensureThreadFolder(TEST_BASE, 'main', 'same');
    const result = renameThreadFolder(TEST_BASE, 'main', 'same', 'same');
    expect(result).toBe(p);
  });
});
