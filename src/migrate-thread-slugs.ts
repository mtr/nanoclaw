import { readEnvFile } from './env.js';
import { getThreads, updateThreadName, getThreadBySlug } from './db.js';
import { generateThreadSlug } from './slug-generator.js';
import { makeUniqueThreadSlug } from './thread-helpers.js';
import { ensureThreadFolder } from './thread-folder.js';
import { THREAD_DOCS_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Migrate existing threads: generate LLM slugs and create folders.
 * Uses thread.name (which is the auto-generated name from the first message)
 * as input to Haiku.
 */
export async function migrateExistingThreads(
  chatJids: string[],
): Promise<{ migrated: number; failed: number }> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = secrets.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('No ANTHROPIC_API_KEY — skipping thread slug migration');
    return { migrated: 0, failed: 0 };
  }

  let migrated = 0;
  let failed = 0;

  for (const chatJid of chatJids) {
    const threads = getThreads(chatJid);
    const existingSlugs = threads.map((t) => t.slug);

    for (const thread of threads) {
      // Skip threads that already have a non-timestamp slug
      if (
        !thread.slug.startsWith('thread-') &&
        !thread.slug.startsWith('20')
      ) {
        // Already has a content-based slug — just ensure folder exists
        const groupFolder = chatJid.startsWith('cli:') ? 'cli' : 'main';
        ensureThreadFolder(THREAD_DOCS_DIR, groupFolder, thread.slug);
        continue;
      }

      try {
        const input =
          thread.name !== 'New conversation' ? thread.name : thread.slug;

        const llmSlug = await generateThreadSlug(input, apiKey, existingSlugs);
        const uniqueSlug = makeUniqueThreadSlug({
          chatJid,
          baseName: llmSlug,
          currentThreadId: thread.id,
          findBySlug: getThreadBySlug,
        });

        const displayName = uniqueSlug.replace(/-/g, ' ');
        const groupFolder = chatJid.startsWith('cli:') ? 'cli' : 'main';

        updateThreadName(thread.id, displayName, uniqueSlug);
        ensureThreadFolder(THREAD_DOCS_DIR, groupFolder, uniqueSlug);

        existingSlugs.push(uniqueSlug);
        migrated++;

        logger.info(
          { threadId: thread.id, oldSlug: thread.slug, newSlug: uniqueSlug },
          'Migrated thread slug',
        );
      } catch (err) {
        failed++;
        logger.error(
          { threadId: thread.id, err },
          'Failed to migrate thread slug',
        );
      }
    }
  }

  return { migrated, failed };
}
