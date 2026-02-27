import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  recordTtsUsage,
  getTtsUsageSummary,
  setBudget,
  getBudgets,
  checkBudget,
} from './cost-tracker.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('CostTracker', () => {
  it('records TTS usage', () => {
    recordTtsUsage({
      characters: 500,
      costEstimate: 0.0075,
      model: 'gpt-4o-mini-tts',
      messageId: 'msg-1',
    });
    const summary = getTtsUsageSummary();
    expect(summary.today.characters).toBe(500);
    expect(summary.today.cost).toBeCloseTo(0.0075);
  });

  it('sets and retrieves budgets', () => {
    setBudget('monthly', 10.0);
    const budgets = getBudgets();
    expect(budgets.monthly).toBe(10.0);
    // Auto-derived values
    expect(budgets.weekly).toBeCloseTo(10.0 / 4.35, 1);
    expect(budgets.daily).toBeCloseTo(10.0 / 30.44, 1);
  });

  it('reports budget status with alert tier', () => {
    setBudget('daily', 1.0);
    recordTtsUsage({
      characters: 1000,
      costEstimate: 0.85,
      model: 'gpt-4o-mini-tts',
      messageId: 'msg-2',
    });
    const status = checkBudget();
    expect(status.daily!.percentUsed).toBeCloseTo(85);
    expect(status.daily!.alertTier).toBe('warning'); // 80-95% = warning
  });

  it('blocks TTS when budget exceeded', () => {
    setBudget('daily', 0.5);
    recordTtsUsage({
      characters: 5000,
      costEstimate: 0.55,
      model: 'gpt-4o-mini-tts',
      messageId: 'msg-3',
    });
    const status = checkBudget();
    expect(status.daily!.alertTier).toBe('exceeded');
    expect(status.ttsAllowed).toBe(false);
  });

  it('returns all-null periods and ttsAllowed when no budget set', () => {
    const status = checkBudget();
    expect(status.daily).toBeNull();
    expect(status.weekly).toBeNull();
    expect(status.monthly).toBeNull();
    expect(status.ttsAllowed).toBe(true);
  });

  it('accumulates multiple usage records in summary', () => {
    recordTtsUsage({
      characters: 200,
      costEstimate: 0.01,
      model: 'gpt-4o-mini-tts',
      messageId: 'msg-a',
    });
    recordTtsUsage({
      characters: 300,
      costEstimate: 0.02,
      model: 'gpt-4o-mini-tts',
      messageId: 'msg-b',
    });
    const summary = getTtsUsageSummary();
    expect(summary.today.characters).toBe(500);
    expect(summary.today.cost).toBeCloseTo(0.03);
    expect(summary.today.count).toBe(2);
  });

  it('records TTS usage without messageId', () => {
    recordTtsUsage({
      characters: 100,
      costEstimate: 0.005,
      model: 'gpt-4o-mini-tts',
    });
    const summary = getTtsUsageSummary();
    expect(summary.today.characters).toBe(100);
    expect(summary.today.cost).toBeCloseTo(0.005);
    expect(summary.today.count).toBe(1);
  });
});
