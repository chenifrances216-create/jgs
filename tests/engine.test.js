'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { payoutSchedule, nextPayoutAt, withdrawalWindow, accrue, isBusinessDay } = require('../server/engine');
const { openDatabase } = require('../server/db');

/** Thursday 12 Nov 2026, 10:00 EAT. */
const THURSDAY = '2026-11-12T07:00:00.000Z';

function seedInvestment(db, overrides = {}) {
  const user = {
    id: 'user-1',
    phone: '0712000001',
    name: 'Member 0712000001',
    hash: 'scrypt$deadbeef$deadbeef',
    code: 'ABC123',
  };
  db.prepare(
    `INSERT INTO users (id, phone, name, password_hash, referral_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(user.id, user.phone, user.name, user.hash, user.code, new Date().toISOString());

  const investment = {
    id: 'inv-1',
    userId: user.id,
    startedAt: THURSDAY,
    dailyProfit: 3000,
    days: 30,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO investments
       (id, user_id, package_id, ship_name, package_name, amount, daily_profit, days, started_at, status, created_at)
     VALUES (?, ?, 'level-1', 'MV Bahari Star', 'Starter', 50000, ?, ?, ?, 'active', ?)`,
  ).run(
    investment.id,
    investment.userId,
    investment.dailyProfit,
    investment.days,
    investment.startedAt,
    new Date().toISOString(),
  );
  return { user, investment };
}

test('first profit day lands 24 hours after renting and weekends are skipped', () => {
  const schedule = payoutSchedule(THURSDAY, 4);
  assert.deepEqual(schedule, [
    '2026-11-13T07:00:00.000Z', // Friday
    '2026-11-16T07:00:00.000Z', // Monday (Sat + Sun skipped)
    '2026-11-17T07:00:00.000Z', // Tuesday
    '2026-11-18T07:00:00.000Z', // Wednesday
  ]);
});

test('weekend days are not business days in East Africa Time', () => {
  assert.equal(isBusinessDay('2026-11-13T07:00:00.000Z'), true); // Friday
  assert.equal(isBusinessDay('2026-11-14T07:00:00.000Z'), false); // Saturday
  assert.equal(isBusinessDay('2026-11-15T07:00:00.000Z'), false); // Sunday
  assert.equal(isBusinessDay('2026-11-15T21:30:00.000Z'), true); // Monday 00:30 EAT
});

test('next payout advances only after a day has been paid', () => {
  assert.equal(nextPayoutAt(THURSDAY, 30, 0), '2026-11-13T07:00:00.000Z');
  assert.equal(nextPayoutAt(THURSDAY, 30, 1), '2026-11-16T07:00:00.000Z');
  assert.equal(nextPayoutAt(THURSDAY, 2, 2), null);
});

test('withdrawal window follows Monday-Friday 10:00-17:00 EAT', () => {
  assert.equal(withdrawalWindow('2026-11-13T09:00:00.000Z').open, true); // Friday 12:00 EAT
  assert.equal(withdrawalWindow('2026-11-13T05:00:00.000Z').open, false); // Friday 08:00 EAT
  assert.equal(withdrawalWindow('2026-11-15T09:00:00.000Z').open, false); // Sunday 12:00 EAT
  assert.match(withdrawalWindow('2026-11-13T05:00:00.000Z').message, /10:00 EAT/);
});

test('a profit day is credited exactly once, even when accrual runs repeatedly', () => {
  const db = openDatabase(':memory:');
  seedInvestment(db);

  // Friday 13 Nov 2026 11:00 EAT - only the first profit day is due.
  const first = accrue(db, '2026-11-13T08:00:00.000Z');
  assert.equal(first.length, 1);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get('user-1').balance, 3000);

  const second = accrue(db, '2026-11-13T08:00:00.000Z');
  const third = accrue(db, '2026-11-13T09:30:00.000Z');
  assert.equal(second.length, 0);
  assert.equal(third.length, 0);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get('user-1').balance, 3000);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM payouts').get().total, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM transactions WHERE type = 'profit'").get().total,
    1,
  );
});

test('missed days are caught up once, never duplicated', () => {
  const db = openDatabase(':memory:');
  seedInvestment(db);

  // Tuesday 17 Nov 2026 11:00 EAT: Friday, Monday and Tuesday are due.
  const caughtUp = accrue(db, '2026-11-17T08:00:00.000Z');
  assert.equal(caughtUp.length, 3);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get('user-1').balance, 9000);

  assert.equal(accrue(db, '2026-11-17T08:00:00.000Z').length, 0);
  assert.equal(accrue(db, '2026-11-17T20:00:00.000Z').length, 0);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get('user-1').balance, 9000);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM payouts').get().total, 3);
});

test('a ship pays its full term then stops', () => {
  const db = openDatabase(':memory:');
  seedInvestment(db, { days: 3 });

  const created = accrue(db, '2027-01-30T08:00:00.000Z');
  assert.equal(created.length, 3);
  assert.equal(db.prepare('SELECT status FROM investments WHERE id = ?').get('inv-1').status, 'finished');
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get('user-1').balance, 9000);

  const later = accrue(db, '2027-06-30T08:00:00.000Z');
  assert.equal(later.length, 0);
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get('user-1').balance, 9000);
});
