/**
 * X Integration - Configuration
 *
 * All environment-specific settings in one place.
 * Override via environment variables or modify defaults here.
 */

import { execFileSync } from 'child_process';
import path from 'path';

// Project root - can be overridden for different deployments
const PROJECT_ROOT = process.env.NANOCLAW_ROOT || process.cwd();

function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  // Linux: try common binary names
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    try {
      return execFileSync('which', [bin], { encoding: 'utf-8' }).trim();
    } catch { /* not found, try next */ }
  }
  return 'google-chrome'; // fallback — let Playwright show a clear error
}

/**
 * Configuration object with all settings
 */
export const config = {
  // Chrome executable path (auto-detected per platform, override with CHROME_PATH)
  chromePath: findChrome(),

  // Browser profile directory for persistent login sessions
  browserDataDir: path.join(PROJECT_ROOT, 'data', 'x-browser-profile'),

  // Auth state marker file
  authPath: path.join(PROJECT_ROOT, 'data', 'x-auth.json'),

  // Browser viewport settings
  viewport: {
    width: 1280,
    height: 800,
  },

  // Timeouts (in milliseconds)
  timeouts: {
    navigation: 30000,
    elementWait: 5000,
    afterClick: 1000,
    afterFill: 1000,
    afterSubmit: 3000,
    pageLoad: 3000,
  },

  // X character limits
  limits: {
    tweetMaxLength: 280,
  },

  // Chrome launch arguments
  chromeArgs: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ],

  // Args to ignore when launching Chrome
  chromeIgnoreDefaultArgs: ['--enable-automation'],
};

