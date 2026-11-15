'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../server/index');
const { openDatabase, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../server/db');
const { accrue } = require('../server/engine');

async function startApp() {
  const db = openDatabase(':memory:');
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function call(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = null;
  }
  return { status: res.status, json, text };
}

const ADMIN_USER = process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

async function adminLogin(base) {
  const res = await call(base, '/api/admin/login', {
    method: 'POST',
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  assert.equal(res.status, 200, 'admin login must succeed');
  return res.json.token;
}

test('members get profit automatically, once per day, and the ledger never duplicates', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  // The published configuration and the original page are served unchanged.
  const config = await call(app.base, '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.json.packages.length, 13);
  assert.equal(config.json.minDeposit, 5000);
  assert.equal(config.json.rules.minWithdraw, 3000);
  assert.equal(config.json.rules.withdrawFeeRate, 0.1);
  assert.equal(config.json.rules.inviteBonusPercent, 10);
  assert.equal(config.json.rules.withdrawOpenHour, 10);
  assert.equal(config.json.rules.withdrawCloseHour, 17);
  assert.equal(config.json.rules.capitalLocked, true);
  const topTier = config.json.packages.find((p) => p.capital === 1000000);
  assert.equal(topTier.dailyProfit, 37000);
  const entryTier = config.json.packages.find((p) => p.capital === 10000);
  assert.equal(entryTier.dailyProfit, 500);

  const page = await call(app.base, '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Ship Transfer/);

  // Owner registers first and becomes the admin.
  const owner = await call(app.base, '/api/auth/register', {
    method: 'POST',
    body: { phone: '0712000001', password: 'secret123' },
  });
  assert.equal(owner.status, 201);
  assert.equal(owner.json.user.role, 'member');
  const ownerToken = owner.json.token;
  const adminToken = await adminLogin(app.base);

  // Member joins with the owner's referral code.
  const member = await call(app.base, '/api/auth/register', {
    method: 'POST',
    body: { phone: '0712000002', password: 'secret123', inviteCode: owner.json.user.referralCode },
  });
  assert.equal(member.status, 201);
  const memberToken = member.json.token;

  // Duplicate registration is refused.
  const duplicate = await call(app.base, '/api/auth/register', {
    method: 'POST',
    body: { phone: '0712000002', password: 'secret123' },
  });
  assert.equal(duplicate.status, 409);

  // Member deposits and the sandbox confirms the payment.
  const deposit = await call(app.base, '/api/deposit', {
    method: 'POST',
    token: memberToken,
    body: { amount: 100000, method: 'mpesa', phone: '0712000002' },
  });
  assert.equal(deposit.status, 201);
  assert.equal(deposit.json.transaction.status, 'pending');
  const depositId = deposit.json.transaction.id;

  // A member can never credit a deposit on their own.
  const selfCredit = await call(app.base, `/api/admin/requests/${depositId}/decision`, {
    method: 'POST',
    token: memberToken,
    body: { action: 'approve' },
  });
  assert.equal(selfCredit.status, 401);

  const confirmed = await call(app.base, `/api/admin/requests/${depositId}/decision`, {
    method: 'POST',
    token: adminToken,
    body: { action: 'approve' },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.transaction.status, 'completed');

  // Confirming the same deposit twice must not credit the capital twice.
  const confirmedAgain = await call(app.base, `/api/admin/requests/${depositId}/decision`, {
    method: 'POST',
    token: adminToken,
    body: { action: 'approve' },
  });
  assert.equal(confirmedAgain.status, 400);
  const memberAfterDeposit = await call(app.base, '/api/me', { token: memberToken });
  assert.equal(memberAfterDeposit.json.user.capital, 100000);

  // Referral bonus is paid once, to the referrer.
  const ownerAfterBonus = await call(app.base, '/api/me', { token: ownerToken });
  assert.equal(ownerAfterBonus.json.user.balance, 10000);

  // Member rents a ship.
  const invest = await call(app.base, '/api/invest', {
    method: 'POST',
    token: memberToken,
    body: { packageId: 'tier-10000' },
  });
  assert.equal(invest.status, 201);
  assert.equal(invest.json.user.capital, 90000);
  assert.equal(invest.json.investment.dailyProfit, 500);

  // Backdate the rental so the whole 30-day term is due, then read the balance
  // several times: the profit must arrive once and never repeat.
  app.db
    .prepare('UPDATE investments SET started_at = ? WHERE id = ?')
    .run('2026-01-05T07:00:00.000Z', invest.json.investment.id);

  const firstRead = await call(app.base, '/api/me', { token: memberToken });
  assert.equal(firstRead.json.user.balance, 15000);

  const secondRead = await call(app.base, '/api/me', { token: memberToken });
  assert.equal(secondRead.json.user.balance, 15000);

  assert.equal(accrue(app.db).length, 0);
  assert.equal(accrue(app.db).length, 0);

  const ledger = app.db
    .prepare('SELECT COUNT(*) AS total, SUM(amount) AS paid FROM payouts WHERE investment_id = ?')
    .get(invest.json.investment.id);
  assert.equal(ledger.total, 30);
  assert.equal(ledger.paid, 15000);

  const investments = await call(app.base, '/api/investments', { token: memberToken });
  assert.equal(investments.json.investments.length, 1);
  assert.equal(investments.json.investments[0].daysPaid, 30);
  assert.equal(investments.json.investments[0].status, 'finished');
  assert.equal(investments.json.investments[0].earned, 15000);

  const profitHistory = await call(app.base, '/api/transactions?type=profit', { token: memberToken });
  assert.equal(profitHistory.json.transactions.length, 30);

  // Withdrawals below TZS 3,000 are refused.
  const belowMin = await call(app.base, '/api/withdraw', {
    method: 'POST',
    token: memberToken,
    body: { amount: 2000, method: 'mpesa', account: '0712000002' },
  });
  assert.equal(belowMin.status, 400);

  // Withdrawals cannot exceed the profit balance.
  const tooMuch = await call(app.base, '/api/withdraw', {
    method: 'POST',
    token: memberToken,
    body: { amount: 500000, method: 'mpesa', account: '0712000002' },
  });
  assert.equal(tooMuch.status, 400);

  // Admin overview lists the members.
  const overview = await call(app.base, '/api/admin/overview', { token: adminToken });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.stats.members, 2);
  assert.equal(overview.json.stats.depositors, 1);
  assert.equal(overview.json.stats.registeredOnly, 1);
  assert.equal(overview.json.stats.totalDeposited, 100000);

  // Members cannot read the admin panel.
  const forbidden = await call(app.base, '/api/admin/overview', { token: memberToken });
  assert.equal(forbidden.status, 401);

  // Unauthenticated access is refused.
  const anonymous = await call(app.base, '/api/me');
  assert.equal(anonymous.status, 401);

  // Wrong password is refused.
  const badLogin = await call(app.base, '/api/auth/login', {
    method: 'POST',
    body: { phone: '0712000002', password: 'wrong-password' },
  });
  assert.equal(badLogin.status, 401);
});

test('admin approval credits a deposit exactly once', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const owner = await call(app.base, '/api/auth/register', {
    method: 'POST',
    body: { phone: '0713000001', password: 'secret123' },
  });
  const member = await call(app.base, '/api/auth/register', {
    method: 'POST',
    body: { phone: '0713000002', password: 'secret123' },
  });

  const adminToken = await adminLogin(app.base);

  const deposit = await call(app.base, '/api/deposit', {
    method: 'POST',
    token: member.json.token,
    body: { amount: 20000, method: 'mpesa' },
  });

  const approve = await call(
    app.base,
    `/api/admin/requests/${deposit.json.transaction.id}/decision`,
    { method: 'POST', token: adminToken, body: { action: 'approve' } },
  );
  assert.equal(approve.status, 200);
  assert.equal(approve.json.transaction.status, 'completed');

  const approveAgain = await call(
    app.base,
    `/api/admin/requests/${deposit.json.transaction.id}/decision`,
    { method: 'POST', token: adminToken, body: { action: 'approve' } },
  );
  assert.equal(approveAgain.status, 400);

  const me = await call(app.base, '/api/me', { token: member.json.token });
  assert.equal(me.json.user.capital, 20000);
});

test('admin panel manages members, balances, passwords, blocks and deposit numbers', async (t) => {
  const app = await startApp();
  t.after(() => app.close());

  const badLogin = await call(app.base, '/api/admin/login', {
    method: 'POST',
    body: { username: ADMIN_USER, password: 'not-the-password' },
  });
  assert.equal(badLogin.status, 401);

  const adminToken = await adminLogin(app.base);

  const member = await call(app.base, '/api/auth/register', {
    method: 'POST',
    body: { phone: '0714000001', password: 'secret123' },
  });
  assert.equal(member.status, 201);
  const memberId = member.json.user.id;

  // A member token is not an admin token: the panel has its own login.
  const asMember = await call(app.base, '/api/admin/users', { token: member.json.token });
  assert.equal(asMember.status, 401);

  // A new member without a deposit sits in the "registered only" group.
  const fresh = await call(app.base, '/api/admin/users', { token: adminToken });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.members.length, 1);
  assert.equal(fresh.json.members[0].group, 'registered');

  // Credit and debit a member balance from the panel.
  const credit = await call(app.base, `/api/admin/users/${memberId}/balance`, {
    method: 'POST',
    token: adminToken,
    body: { direction: 'add', amount: 5000, note: 'manual credit' },
  });
  assert.equal(credit.status, 200);
  assert.equal(credit.json.member.balance, 5000);

  const debit = await call(app.base, `/api/admin/users/${memberId}/balance`, {
    method: 'POST',
    token: adminToken,
    body: { direction: 'subtract', amount: 2000, note: 'correction' },
  });
  assert.equal(debit.status, 200);
  assert.equal(debit.json.member.balance, 3000);

  const overDebit = await call(app.base, `/api/admin/users/${memberId}/balance`, {
    method: 'POST',
    token: adminToken,
    body: { direction: 'subtract', amount: 999999 },
  });
  assert.equal(overDebit.status, 400);

  // The panel can read the member password.
  const revealed = await call(app.base, `/api/admin/users/${memberId}/password`, { token: adminToken });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.json.password, 'secret123');

  // The panel can block withdrawals.
  const blocked = await call(app.base, `/api/admin/users/${memberId}/withdraw-block`, {
    method: 'POST',
    token: adminToken,
    body: { blocked: true, reason: 'Under review' },
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.member.withdrawBlocked, true);

  const blockedWithdraw = await call(app.base, '/api/withdraw', {
    method: 'POST',
    token: member.json.token,
    body: { amount: 3000, method: 'mpesa', account: '0714000001' },
  });
  assert.ok(blockedWithdraw.status >= 400, 'a blocked member cannot withdraw');

  // Deposit numbers typed into the panel reach the member app.
  const saved = await call(app.base, '/api/admin/settings', {
    method: 'PUT',
    token: adminToken,
    body: {
      depositNumbers: [{ id: 'shop', label: 'Duka la wakala', number: '0754999888', holder: 'Ship Transfer' }],
      depositMethods: [{ id: 'mpesa', label: 'M-Pesa', account: '0754000111', holder: 'Ship Transfer' }],
    },
  });
  assert.equal(saved.status, 200);
  const config = await call(app.base, '/api/config');
  assert.equal(config.json.depositNumbers[0].number, '0754999888');
  assert.equal(config.json.depositMethods.find((m) => m.id === 'mpesa').account, '0754000111');

  // Approving a deposit moves the member into the active group.
  const deposit = await call(app.base, '/api/deposit', {
    method: 'POST',
    token: member.json.token,
    body: { amount: 20000, method: 'mpesa', phone: '0714000001' },
  });
  assert.equal(deposit.status, 201);
  const approved = await call(app.base, `/api/admin/requests/${deposit.json.transaction.id}/decision`, {
    method: 'POST',
    token: adminToken,
    body: { action: 'approve' },
  });
  assert.equal(approved.status, 200);
  const active = await call(app.base, '/api/admin/users?filter=active', { token: adminToken });
  assert.equal(active.json.members.length, 1);
  assert.equal(active.json.members[0].group, 'active');
  assert.equal(active.json.members[0].capital, 20000);

  // Deleting a member removes the account and its session.
  const throwaway = await call(app.base, '/api/auth/register', {
    method: 'POST',
    body: { phone: '0714000009', password: 'secret123' },
  });
  const removed = await call(app.base, `/api/admin/users/${throwaway.json.user.id}/delete`, {
    method: 'POST',
    token: adminToken,
    body: { confirmPhone: '0714000009' },
  });
  assert.equal(removed.status, 200);
  const gone = await call(app.base, '/api/me', { token: throwaway.json.token });
  assert.equal(gone.status, 401);
});
