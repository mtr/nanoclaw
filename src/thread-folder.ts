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
