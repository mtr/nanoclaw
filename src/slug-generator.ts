import Anthropic from '@anthropic-ai/sdk';

import { slugify } from './router.js';
import { logger } from './logger.js';

const MAX_INPUT_LENGTH = 500;

/**
 * Call Claude Haiku to generate a short, memorable thread slug from
 * the user's first message. Falls back to simple slugification on error.
 */
export async function generateThreadSlug(
  firstMessage: string,
  apiKey: string,
  existingSlugs: string[],
): Promise<string> {
  const truncated = firstMessage.slice(0, MAX_INPUT_LENGTH);
  const fallback = slugify(truncated);

  try {
    const client = new Anthropic({ apiKey });

    const avoidList =
      existingSlugs.length > 0
        ? `\nAvoid these existing slugs: ${existingSlugs.join(', ')}`
        : '';

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [
        {
          role: 'user',
          content: `Generate a 2-4 word kebab-case slug that describes this conversation topic. Be specific and memorable. Return ONLY the slug, nothing else.${avoidList}\n\nMessage: ${truncated}`,
        },
      ],
    });

    const text =
      response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : '';

    if (!text) return fallback;

    // Normalize: if Haiku returns natural language, slugify it
    const slug = text.includes('-') ? text.toLowerCase() : slugify(text);
    return slug || fallback;
  } catch (err) {
    logger.warn({ err }, 'LLM slug generation failed, using fallback');
    return fallback;
  }
}
