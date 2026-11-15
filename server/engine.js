'use strict';

/**
 * Profit engine.
 *
 * Rules taken from the product's own wording:
 *  - the first profit day starts 24 hours after a ship is rented;
 *  - profit is credited on business days only (Monday - Friday, EAT);
 *  - a ship pays `days` profit days in total, then it is finished;
 *  - every credited day is written to the `payouts` ledger, and the
 *    UNIQUE (investment_id, day_index) constraint makes a second credit
 *    for the same day impossible.
 *
 * The engine is idempotent: running it twice (scheduler tick, restart,
 * request) credits each due day exactly once.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000; // Africa/Dar_es_Salaam, UTC+3, no DST

function eatShift(value) {
  return new Date(new Date(value).getTime() + EAT_OFFSET_MS);
}

/** Weekday in East Africa Time: 0 = Sunday ... 6 = Saturday. */
function eatWeekday(value) {
  return eatShift(value).getUTCDay();
}

function isBusinessDay(value) {
  const weekday = eatWeekday(value);
  return weekday !== 0 && weekday !== 6;
}

/**
 * Due timestamps for every profit day of an investment.
 * Slot 0 is `startedAt + 24h`; weekend slots move to the next business day
 * keeping the same time of day, so each ship keeps its own payout hour.
 */
function payoutSchedule(startedAt, days) {
  const total = Number(days);
  if (!Number.isFinite(total) || total <= 0) return [];
  const out = [];
  let cursor = new Date(startedAt).getTime() + DAY_MS;
  for (let index = 0; index < total; index += 1) {
    while (!isBusinessDay(cursor)) cursor += DAY_MS;
    out.push(new Date(cursor).toISOString());
    cursor += DAY_MS;
  }
  return out;
}

/** Next unpaid profit day, or null when the ship has paid every day. */
function nextPayoutAt(startedAt, days, paidDays) {
  const schedule = payoutSchedule(startedAt, days);
  if (paidDays >= schedule.length) return null;
  return schedule[paidDays];
}

/** Withdrawals: Monday - Friday, 10:00 - 17:00 EAT. */
function withdrawalWindow(now = new Date()) {
  const shifted = eatShift(now);
  const weekday = shifted.getUTCDay();
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const businessDay = weekday >= 1 && weekday <= 5;
  const open = businessDay && minutes >= 10 * 60 && minutes < 17 * 60;

  let message = '';
  if (!open) {
    if (!businessDay) message = 'Reopens Monday at 10:00 EAT.';
    else if (minutes < 10 * 60) message = 'Opens today at 10:00 EAT.';
    else message = 'Reopens tomorrow at 10:00 EAT.';
  }
  return { open, message, weekday, minutes };
}

/**
 * Credit every profit day that is due. Returns the list of credits created
 * by this call (empty when nothing was due or everything was already paid).
 */
function accrue(db, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const nowIsoString = new Date(now).toISOString();

  const insertPayout = db.prepare(`
    INSERT OR IGNORE INTO payouts (id, investment_id, user_id, day_index, amount, paid_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const creditUser = db.prepare(`
    UPDATE users SET balance = balance + ?, total_profit = total_profit + ? WHERE id = ?
  `);
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (id, user_id, type, label, amount, status, note, created_at)
    VALUES (?, ?, 'profit', ?, ?, 'completed', ?, ?)
  `);
  const countPaid = db.prepare('SELECT COUNT(*) AS total FROM payouts WHERE investment_id = ?');
  const finishInvestment = db.prepare("UPDATE investments SET status = 'finished' WHERE id = ?");
  const activeInvestments = db.prepare("SELECT * FROM investments WHERE status = 'active'");

  const run = db.transaction(() => {
    const created = [];
    for (const investment of activeInvestments.all()) {
      const schedule = payoutSchedule(investment.started_at, investment.days);
      for (let dayIndex = 0; dayIndex < schedule.length; dayIndex += 1) {
        if (new Date(schedule[dayIndex]).getTime() > nowMs) break;
        const result = insertPayout.run(
          crypto.randomUUID(),
          investment.id,
          investment.user_id,
          dayIndex,
          investment.daily_profit,
          nowIsoString,
        );
        if (result.changes !== 1) continue; // already paid: never credit twice
        creditUser.run(investment.daily_profit, investment.daily_profit, investment.user_id);
        insertTransaction.run(
          crypto.randomUUID(),
          investment.user_id,
          `Daily profit · ${investment.ship_name}`,
          investment.daily_profit,
          `${dayIndex + 1}/${investment.days}`,
          nowIsoString,
        );
        created.push({ investmentId: investment.id, dayIndex, amount: investment.daily_profit });
      }

      const paid = countPaid.get(investment.id).total;
      if (paid >= investment.days) finishInvestment.run(investment.id);
    }
    return created;
  });

  return run();
}

/**
 * Start the scheduler. It runs immediately (catching up on any missed days
 * after a restart) and then every `intervalMs`.
 */
function startScheduler(db, intervalMs = 30000, logger = console) {
  const tick = () => {
    try {
      const created = accrue(db);
      if (created.length) {
        logger.log(`[profit] credited ${created.length} profit day(s)`);
      }
    } catch (err) {
      logger.error('[profit] accrual failed:', err);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  DAY_MS,
  EAT_OFFSET_MS,
  eatShift,
  eatWeekday,
  isBusinessDay,
  payoutSchedule,
  nextPayoutAt,
  withdrawalWindow,
  accrue,
  startScheduler,
};
