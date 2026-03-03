import fs from 'fs';
import path from 'path';

/**
 * Ensure the thread folder exists at `{base}/{groupFolder}/{slug}/`.
 * Returns the absolute path.
 */
export function ensureThreadFolder(
  base: string,
  groupFolder: string,
  slug: string,
): string {
  const dirPath = path.join(base, groupFolder, slug);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/**
 * Move a thread folder into the `.archived/` subdirectory.
 * No-op if the source folder doesn't exist.
 */
export function archiveThreadFolder(
  base: string,
  groupFolder: string,
  slug: string,
): void {
  const src = path.join(base, groupFolder, slug);
  const dest = path.join(base, groupFolder, '.archived', slug);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

/**
 * Restore a thread folder from `.archived/` back to the group directory.
 * If the archived source doesn't exist, creates the destination directly.
 */
export function unarchiveThreadFolder(
  base: string,
  groupFolder: string,
  slug: string,
): void {
  const src = path.join(base, groupFolder, '.archived', slug);
  const dest = path.join(base, groupFolder, slug);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  } else {
    fs.mkdirSync(dest, { recursive: true });
  }
}

/**
 * Rename a thread folder from oldSlug to newSlug.
 * If the old folder doesn't exist, creates the new one.
 * Returns the new absolute path.
 */
export function renameThreadFolder(
  base: string,
  groupFolder: string,
  oldSlug: string,
  newSlug: string,
): string {
  if (oldSlug === newSlug) {
    return ensureThreadFolder(base, groupFolder, newSlug);
  }

  const oldPath = path.join(base, groupFolder, oldSlug);
  const newPath = path.join(base, groupFolder, newSlug);

  if (fs.existsSync(oldPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
  } else {
    fs.mkdirSync(newPath, { recursive: true });
  }

  return newPath;
}
