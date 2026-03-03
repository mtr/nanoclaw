#!/usr/bin/env npx tsx
/**
 * X Integration - Read Tweet/Thread
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx read.ts
 *
 * Navigates to a tweet and extracts the full thread by the original poster.
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult } from '../lib/browser.js';

interface ReadInput {
  tweetUrl: string;
}

interface TweetData {
  author: string;
  handle: string;
  text: string;
  time: string;
}

async function readThread(input: ReadInput): Promise<ScriptResult> {
  const { tweetUrl } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
  }

  let context: Awaited<ReturnType<typeof getBrowserContext>> | null = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      return { success: false, message: error || 'Navigation failed' };
    }

    // Wait for tweet articles to load
    await page.waitForSelector('article[data-testid="tweet"]', {
      timeout: config.timeouts.elementWait,
    });

    // Extract the original poster's info from the main tweet
    const mainTweet = page.locator('article[data-testid="tweet"]').first();
    const opHandle = await mainTweet
      .locator('a[role="link"][href*="/"]')
      .filter({ hasText: '@' })
      .first()
      .textContent()
      .catch(() => null);

    // Helper to extract tweet data from currently visible articles.
    // X.com uses virtual scrolling — articles leave the DOM when scrolled
    // out of view — so we must collect data before scrolling further.
    const seenTexts = new Set<string>();
    const tweets: TweetData[] = [];

    async function collectVisibleTweets(): Promise<void> {
      const articles = page.locator('article[data-testid="tweet"]');
      const count = await articles.count();

      for (let i = 0; i < count; i++) {
        const article = articles.nth(i);

        const text = await article
          .locator('[data-testid="tweetText"]')
          .first()
          .textContent()
          .catch(() => '');

        if (!text || seenTexts.has(text)) continue;

        const handle = await article
          .locator('a[role="link"][href*="/"]')
          .filter({ hasText: '@' })
          .first()
          .textContent()
          .catch(() => '');

        // Only include tweets from the original poster (thread by OP)
        if (opHandle && handle && handle !== opHandle) continue;

        const author = await article
          .locator('[data-testid="User-Name"] span')
          .first()
          .textContent()
          .catch(() => '');

        const time = await article
          .locator('time')
          .first()
          .getAttribute('datetime')
          .catch(() => '');

        seenTexts.add(text);
        tweets.push({
          author: author || '',
          handle: handle || '',
          text,
          time: time || '',
        });
      }
    }

    // Collect initial tweets, then scroll to load more
    await collectVisibleTweets();

    for (let i = 0; i < 10; i++) {
      const prevCount = tweets.length;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      await collectVisibleTweets();
      if (tweets.length === prevCount) break;
    }

    if (tweets.length === 0) {
      return { success: false, message: 'Could not extract any tweet content' };
    }

    // Format the thread as readable text
    const header = `Thread by ${tweets[0].author} (${tweets[0].handle})`;
    const separator = '─'.repeat(40);
    const body = tweets
      .map((t, i) => `${i + 1}/${tweets.length}\n${t.text}`)
      .join(`\n${separator}\n`);

    const formatted = `${header}\n${'═'.repeat(40)}\n${body}`;

    return {
      success: true,
      message: formatted,
      data: { tweets, tweetCount: tweets.length },
    };
  } finally {
    if (context) await context.close();
  }
}

runScript<ReadInput>(readThread);
