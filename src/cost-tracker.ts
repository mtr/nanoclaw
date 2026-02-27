import { getDb } from './db.js';

export interface TtsUsageRecord {
  characters: number;
  costEstimate: number;
  model: string;
  messageId?: string;
}

export interface UsageSummary {
  today: { characters: number; cost: number; count: number };
  thisWeek: { characters: number; cost: number; count: number };
  thisMonth: { characters: number; cost: number; count: number };
}

export interface BudgetPeriodStatus {
  budget: number;
  spent: number;
  percentUsed: number;
  alertTier: 'ok' | 'info' | 'warning' | 'critical' | 'exceeded';
}

export interface BudgetStatus {
  daily: BudgetPeriodStatus | null;
  weekly: BudgetPeriodStatus | null;
  monthly: BudgetPeriodStatus | null;
  ttsAllowed: boolean;
}

function alertTier(percent: number): BudgetPeriodStatus['alertTier'] {
  if (percent >= 100) return 'exceeded';
  if (percent >= 95) return 'critical';
  if (percent >= 80) return 'warning';
  if (percent >= 60) return 'info';
  return 'ok';
}

export function recordTtsUsage(record: TtsUsageRecord): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tts_usage (characters, cost_estimate, model, message_id)
     VALUES (?, ?, ?, ?)`,
  ).run(
    record.characters,
    record.costEstimate,
    record.model,
    record.messageId ?? null,
  );
}

export function getTtsUsageSummary(): UsageSummary {
  const db = getDb();
  const query = (where: string) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(characters), 0) as characters,
                COALESCE(SUM(cost_estimate), 0) as cost,
                COUNT(*) as count
         FROM tts_usage WHERE ${where}`,
      )
      .get() as { characters: number; cost: number; count: number };

  return {
    today: query(`date(timestamp) = date('now')`),
    thisWeek: query(`timestamp >= datetime('now', 'weekday 0', '-7 days')`),
    thisMonth: query(
      `strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`,
    ),
  };
}

export function setBudget(
  period: 'daily' | 'weekly' | 'monthly',
  amount: number,
): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO tts_budgets (period, amount, is_auto_derived) VALUES (?, ?, ?)`,
  );

  // Set the explicit budget
  upsert.run(period, amount, 0);

  // Auto-derive other periods
  if (period === 'monthly') {
    upsert.run('weekly', amount / 4.35, 1);
    upsert.run('daily', amount / 30.44, 1);
  } else if (period === 'weekly') {
    upsert.run('daily', amount / 7, 1);
  }
  // Don't auto-derive upward (daily doesn't imply weekly/monthly)
}

export function getBudgets(): Record<string, number> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT period, amount FROM tts_budgets`)
    .all() as Array<{ period: string; amount: number }>;
  const budgets: Record<string, number> = {};
  for (const row of rows) budgets[row.period] = row.amount;
  return budgets;
}

export function checkBudget(): BudgetStatus {
  const budgets = getBudgets();
  const usage = getTtsUsageSummary();

  function periodStatus(
    period: 'daily' | 'weekly' | 'monthly',
  ): BudgetPeriodStatus | null {
    const budget = budgets[period];
    if (budget == null) return null;
    const spentKey =
      period === 'daily'
        ? 'today'
        : period === 'weekly'
          ? 'thisWeek'
          : 'thisMonth';
    const spent = usage[spentKey].cost;
    const percentUsed = budget > 0 ? (spent / budget) * 100 : 0;
    return { budget, spent, percentUsed, alertTier: alertTier(percentUsed) };
  }

  const daily = periodStatus('daily');
  const weekly = periodStatus('weekly');
  const monthly = periodStatus('monthly');

  // TTS is blocked if ANY active period is exceeded
  const ttsAllowed = [daily, weekly, monthly].every(
    (s) => s === null || s.alertTier !== 'exceeded',
  );

  return { daily, weekly, monthly, ttsAllowed };
}
