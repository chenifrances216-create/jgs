'use strict';

/**
 * Ship Transfer HTTP server.
 *
 * Serves the original single-page app from ./public and the JSON API the
 * frontend expects. The profit engine (server/engine.js) runs on a timer and
 * on every balance-reading request, so members see credited profit even when
 * they are not online.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  openDatabase,
  defaultDatabasePath,
  hashPassword,
  verifyPassword,
  makeReferralCode,
  newId,
  nowIso,
} = require('./db');
const { accrue, startScheduler, withdrawalWindow, nextPayoutAt } = require('./engine');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------- helpers ------------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
      return undefined;
    });
    req.on('error', reject);
  });
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 15) {
    throw new HttpError(400, 'Enter a valid phone number');
  }
  return digits;
}

function requireAmount(value, label) {
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, `${label} must be a positive amount`);
  }
  return amount;
}

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch (err) {
      out[row.key] = null;
    }
  }
  return out;
}

function listPackages(db) {
  return db
    .prepare('SELECT * FROM packages ORDER BY sort_order, level')
    .all()
    .map((row) => ({
      id: row.id,
      level: row.level,
      name: row.name,
      shipName: row.ship_name,
      tag: row.tag,
      image: row.image,
      capital: row.capital,
      dailyProfit: row.daily_profit,
      days: row.days,
      perks: JSON.parse(row.perks || '[]'),
    }));
}

function buildConfig(db) {
  const settings = getSettings(db);
  return {
    minDeposit: settings.minDeposit,
    minWithdraw: settings.minWithdraw,
    withdrawFeeRate: settings.withdrawFeeRate,
    inviteBonusPercent: settings.inviteBonusPercent,
    depositMethods: settings.depositMethods || [],
    depositNumbers: settings.depositNumbers || [],
    withdrawOptions: settings.withdrawOptions || [],
    rules: {
      minWithdraw: settings.minWithdraw,
      withdrawFeeRate: settings.withdrawFeeRate,
    },
    payments: { live: process.env.PAYMENTS_LIVE === 'true' },
    packages: listPackages(db),
  };
}

function serializeUser(db, row) {
  const active = db
    .prepare("SELECT COUNT(*) AS total FROM investments WHERE user_id = ? AND status = 'active'")
    .get(row.id).total;
  const window = withdrawalWindow(new Date());
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    role: row.role,
    balance: row.balance,
    capital: row.capital,
    totalProfit: row.total_profit,
    totalBonus: row.total_bonus,
    vipLevel: row.vip_level,
    activeInvestments: active,
    referralCode: row.referral_code,
    createdAt: row.created_at,
    withdrawal: { open: window.open, message: window.message },
    withdrawBlocked: Boolean(row.withdraw_blocked),
    withdrawBlockReason: row.withdraw_block_reason || '',
  };
}

function serializeTransaction(row) {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    amount: row.amount,
    status: row.status,
    method: row.method,
    channel: row.channel,
    account: row.account,
    phone: row.phone,
    fee: row.fee,
    net: row.net,
    note: row.note,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function serializeInvestment(db, row) {
  const paid = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(amount), 0) AS earned FROM payouts WHERE investment_id = ?')
    .get(row.id);
  const daysPaid = paid.total;
  const projectedTotal = row.daily_profit * row.days;
  return {
    id: row.id,
    shipName: row.ship_name,
    packageName: row.package_name,
    amount: row.amount,
    dailyProfit: row.daily_profit,
    days: row.days,
    daysPaid,
    earned: paid.earned,
    projectedTotal,
    progress: row.days ? Math.round((daysPaid / row.days) * 100) : 0,
    status: row.status,
    startedAt: row.started_at,
    nextPayoutAt: row.status === 'active' ? nextPayoutAt(row.started_at, row.days, daysPaid) : null,
    createdAt: row.created_at,
  };
}

/* -------------------------------- auth --------------------------------- */

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    nowIso(),
  );
  return token;
}

function authenticate(db, req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header);
  if (!match) throw new HttpError(401, 'Please sign in');
  const token = match[1];
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token);
  if (!row) throw new HttpError(401, 'Session expired. Please sign in again.');
  return row;
}

function requireAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Admin access only');
}

function uniqueReferralCode(db) {
  const exists = db.prepare('SELECT 1 FROM users WHERE referral_code = ?');
  return makeReferralCode((code) => Boolean(exists.get(code)));
}

/* ------------------------------ referrals ------------------------------ */

function payInviteBonus(db, inviteeId, depositAmount) {
  const referral = db.prepare('SELECT * FROM referrals WHERE invitee_id = ?').get(inviteeId);
  if (!referral) return 0;
  const percent = Number(getSettings(db).inviteBonusPercent) || 10;
  const bonus = Math.round((depositAmount * percent) / 100);
  if (bonus <= 0) return 0;

  // The WHERE bonus_paid = 0 guard makes this a one-shot payment.
  const marked = db
    .prepare('UPDATE referrals SET bonus_paid = 1, bonus_amount = ? WHERE id = ? AND bonus_paid = 0')
    .run(bonus, referral.id);
  if (marked.changes !== 1) return 0;

  db.prepare('UPDATE users SET balance = balance + ?, total_bonus = total_bonus + ? WHERE id = ?').run(
    bonus,
    bonus,
    referral.referrer_id,
  );
  db.prepare(
    `INSERT INTO transactions (id, user_id, type, label, amount, status, note, created_at)
     VALUES (?, ?, 'invite_bonus', 'Referral bonus', ?, 'completed', ?, ?)`,
  ).run(newId(), referral.referrer_id, bonus, 'First deposit bonus', nowIso());
  return bonus;
}

/* ------------------------------- routes -------------------------------- */

async function handleApi(db, req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, buildConfig(db));
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone);
    const password = String(body.password || '');
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
      throw new HttpError(409, 'This phone number is already registered');
    }

    const inviteCode = String(body.inviteCode || '').trim().toUpperCase();
    const referrer = inviteCode
      ? db.prepare('SELECT * FROM users WHERE referral_code = ?').get(inviteCode)
      : null;

    const adminExists = db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
    const user = {
      id: newId(),
      phone,
      name: `Member ${phone}`,
      role: adminExists ? 'member' : 'admin',
      referralCode: uniqueReferralCode(db),
      createdAt: nowIso(),
    };

    db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, phone, name, password_hash, role, referral_code, referred_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        user.id,
        user.phone,
        user.name,
        hashPassword(password),
        user.role,
        user.referralCode,
        referrer ? referrer.id : null,
        user.createdAt,
      );
      if (referrer) {
        db.prepare('INSERT INTO referrals (id, referrer_id, invitee_id, created_at) VALUES (?, ?, ?, ?)').run(
          newId(),
          referrer.id,
          user.id,
          user.createdAt,
        );
      }
    })();

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const token = createSession(db, user.id);
    return sendJson(res, 201, {
      token,
      user: serializeUser(db, row),
      packages: listPackages(db),
    });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const phone = normalizePhone(body.phone);
    const row = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!row || !verifyPassword(String(body.password || ''), row.password_hash)) {
      throw new HttpError(401, 'Wrong phone number or password');
    }
    const token = createSession(db, row.id);
    accrue(db);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    return sendJson(res, 200, {
      token,
      user: serializeUser(db, fresh),
      packages: listPackages(db),
    });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header);
    if (match) db.prepare('DELETE FROM sessions WHERE token = ?').run(match[1]);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && method === 'GET') {
    const user = authenticate(db, req);
    accrue(db); // keep the balance fresh even between scheduler ticks
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return sendJson(res, 200, { user: serializeUser(db, fresh), packages: listPackages(db) });
  }

  if (pathname === '/api/transactions' && method === 'GET') {
    const user = authenticate(db, req);
    accrue(db);
    const type = url.searchParams.get('type');
    const rows = type
      ? db
          .prepare('SELECT * FROM transactions WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 200')
          .all(user.id, type)
      : db
          .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 200')
          .all(user.id);
    return sendJson(res, 200, { transactions: rows.map(serializeTransaction) });
  }

  if (pathname === '/api/investments' && method === 'GET') {
    const user = authenticate(db, req);
    accrue(db);
    const rows = db
      .prepare('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC')
      .all(user.id);
    return sendJson(res, 200, { investments: rows.map((row) => serializeInvestment(db, row)) });
  }

  if (pathname === '/api/invest' && method === 'POST') {
    const user = authenticate(db, req);
    const body = await readJson(req);
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(String(body.packageId || ''));
    if (!pkg) throw new HttpError(400, 'Choose a ship level');
    if (user.capital < pkg.capital) {
      throw new HttpError(400, 'Not enough capital. Deposit first to rent this ship.');
    }

    const investmentId = newId();
    const startedAt = nowIso();
    db.transaction(() => {
      db.prepare('UPDATE users SET capital = capital - ?, vip_level = MAX(vip_level, ?) WHERE id = ?').run(
        pkg.capital,
        pkg.level,
        user.id,
      );
      db.prepare(
        `INSERT INTO investments
           (id, user_id, package_id, ship_name, package_name, amount, daily_profit, days, started_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).run(
        investmentId,
        user.id,
        pkg.id,
        pkg.ship_name,
        pkg.name,
        pkg.capital,
        pkg.daily_profit,
        pkg.days,
        startedAt,
        startedAt,
      );
      db.prepare(
        `INSERT INTO transactions (id, user_id, type, label, amount, status, note, created_at)
         VALUES (?, ?, 'invest', ?, ?, 'completed', ?, ?)`,
      ).run(newId(), user.id, `Rented ${pkg.ship_name}`, pkg.capital, pkg.name, startedAt);
    })();

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const investment = db.prepare('SELECT * FROM investments WHERE id = ?').get(investmentId);
    return sendJson(res, 201, {
      user: serializeUser(db, fresh),
      investment: serializeInvestment(db, investment),
    });
  }

  if (pathname === '/api/deposit' && method === 'POST') {
    const user = authenticate(db, req);
    const body = await readJson(req);
    const settings = getSettings(db);
    const amount = requireAmount(body.amount, 'Deposit');
    if (amount < Number(settings.minDeposit || 5000)) {
      throw new HttpError(400, `Minimum deposit is TZS ${Number(settings.minDeposit || 5000).toLocaleString('en-US')}`);
    }
    const methods = settings.depositMethods || [];
    const methodId = String(body.method || '');
    const chosen = methods.find((m) => m.id === methodId);
    if (!chosen) throw new HttpError(400, 'Choose a payment method');

    const id = newId();
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO transactions
         (id, user_id, type, label, amount, status, method, channel, phone, fee, net, created_at)
       VALUES (?, ?, 'deposit', 'Deposit', ?, 'pending', ?, ?, ?, 0, 0, ?)`,
    ).run(
      id,
      user.id,
      amount,
      chosen.label,
      chosen.channel || 'mobile_money',
      String(body.phone || user.phone),
      createdAt,
    );

    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    const live = process.env.PAYMENTS_LIVE === 'true';
    return sendJson(res, 201, {
      user: serializeUser(db, user),
      transaction: serializeTransaction(row),
      payment: {
        message: live
          ? 'Approve the payment prompt on your phone.'
          : 'Deposit created in test mode. Use the simulate button to credit it.',
      },
    });
  }

  const simulateMatch = /^\/api\/deposit\/([^/]+)\/simulate$/.exec(pathname);
  if (simulateMatch && method === 'POST') {
    const user = authenticate(db, req);
    if (process.env.PAYMENTS_LIVE === 'true') {
      throw new HttpError(400, 'Payments are live. Sandbox simulation is disabled.');
    }
    const txn = db
      .prepare("SELECT * FROM transactions WHERE id = ? AND user_id = ? AND type = 'deposit'")
      .get(simulateMatch[1], user.id);
    if (!txn) throw new HttpError(404, 'Deposit not found');
    if (txn.status !== 'pending') throw new HttpError(400, 'This deposit was already processed');

    db.transaction(() => {
      const updated = db
        .prepare("UPDATE transactions SET status = 'completed', decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso(), txn.id);
      if (updated.changes !== 1) throw new HttpError(400, 'This deposit was already processed');
      db.prepare('UPDATE users SET capital = capital + ? WHERE id = ?').run(txn.amount, user.id);
      payInviteBonus(db, user.id, txn.amount);
    })();

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return sendJson(res, 200, { user: serializeUser(db, fresh) });
  }

  if (pathname === '/api/withdraw' && method === 'POST') {
    const user = authenticate(db, req);
    if (user.withdraw_blocked) {
      throw new HttpError(403, user.withdraw_block_reason || 'Withdrawals are blocked on this account');
    }
    const window = withdrawalWindow(new Date());
    if (!window.open) {
      throw new HttpError(400, `Withdrawals are open Monday to Friday, 10:00 - 17:00 EAT. ${window.message}`);
    }
    const body = await readJson(req);
    const settings = getSettings(db);
    const amount = requireAmount(body.amount, 'Withdrawal');
    const minWithdraw = Number(settings.minWithdraw || 3000);
    if (amount < minWithdraw) {
      throw new HttpError(400, `Minimum withdrawal is TZS ${minWithdraw.toLocaleString('en-US')}`);
    }
    if (amount > user.balance) {
      throw new HttpError(400, 'Withdrawal is more than your profit balance');
    }

    const options = settings.withdrawOptions || [];
    const chosen = options.find((option) => option.id === String(body.method || ''));
    if (!chosen) throw new HttpError(400, 'Choose a withdrawal method');
    const account = String(body.account || '').trim();
    if (account.length < 5) throw new HttpError(400, 'Enter the account that should receive the money');

    const fee = Math.round(amount * Number(settings.withdrawFeeRate || 0));
    const net = amount - fee;
    const id = newId();
    const createdAt = nowIso();

    db.transaction(() => {
      // The balance >= ? guard makes an overdraft impossible, even with
      // two requests racing each other.
      const debited = db
        .prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
        .run(amount, user.id, amount);
      if (debited.changes !== 1) throw new HttpError(400, 'Withdrawal is more than your profit balance');
      db.prepare(
        `INSERT INTO transactions
           (id, user_id, type, label, amount, status, method, account, fee, net, created_at)
         VALUES (?, ?, 'withdraw', 'Withdrawal', ?, 'pending', ?, ?, ?, ?, ?)`,
      ).run(id, user.id, amount, chosen.label, account, fee, net, createdAt);
    })();

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return sendJson(res, 201, { user: serializeUser(db, fresh), payout: { net, fee } });
  }

  if (pathname === '/api/invite' && method === 'GET') {
    const user = authenticate(db, req);
    const rows = db
      .prepare(
        `SELECT u.name, u.phone, u.created_at, r.bonus_paid, r.bonus_amount
           FROM referrals r JOIN users u ON u.id = r.invitee_id
          WHERE r.referrer_id = ? ORDER BY r.created_at DESC`,
      )
      .all(user.id);
    const settings = getSettings(db);
    return sendJson(res, 200, {
      code: user.referral_code,
      bonusPercent: settings.inviteBonusPercent,
      totalInvited: rows.length,
      totalEarned: rows.reduce((sum, row) => sum + row.bonus_amount, 0),
      invited: rows.map((row) => ({
        name: row.name,
        joinedAt: row.created_at,
        rewarded: Boolean(row.bonus_paid),
      })),
    });
  }

  if (pathname === '/api/account/password' && method === 'POST') {
    const user = authenticate(db, req);
    const body = await readJson(req);
    if (!verifyPassword(String(body.currentPassword || ''), user.password_hash)) {
      throw new HttpError(400, 'Current password is wrong');
    }
    const next = String(body.newPassword || '');
    if (next.length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    })();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/overview' && method === 'GET') {
    const user = authenticate(db, req);
    requireAdmin(user);
    const stats = {
      users: db.prepare('SELECT COUNT(*) AS total FROM users').get().total,
      pendingDeposits: db
        .prepare("SELECT COUNT(*) AS total FROM transactions WHERE type = 'deposit' AND status = 'pending'")
        .get().total,
      pendingWithdrawals: db
        .prepare("SELECT COUNT(*) AS total FROM transactions WHERE type = 'withdraw' AND status = 'pending'")
        .get().total,
      totalDeposited: db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'deposit' AND status = 'completed'")
        .get().total,
    };
    const requests = db
      .prepare(
        `SELECT t.*, u.name AS user_name, u.phone AS user_phone
           FROM transactions t JOIN users u ON u.id = t.user_id
          WHERE t.status = 'pending' AND t.type IN ('deposit', 'withdraw')
          ORDER BY t.created_at ASC LIMIT 100`,
      )
      .all()
      .map((row) => ({
        ...serializeTransaction(row),
        user: { name: row.user_name, phone: row.user_phone },
      }));
    const payouts = db
      .prepare(
        `SELECT t.*, u.name AS user_name FROM transactions t JOIN users u ON u.id = t.user_id
          WHERE t.type = 'withdraw' ORDER BY t.created_at DESC LIMIT 10`,
      )
      .all()
      .map((row) => ({ ...serializeTransaction(row), user: { name: row.user_name } }));
    return sendJson(res, 200, { stats, requests, payouts });
  }

  const decisionMatch = /^\/api\/admin\/transactions\/([^/]+)\/decision$/.exec(pathname);
  if (decisionMatch && method === 'POST') {
    const user = authenticate(db, req);
    requireAdmin(user);
    const body = await readJson(req);
    const action = String(body.action || '');
    if (action !== 'approve' && action !== 'reject') throw new HttpError(400, 'Unknown decision');

    const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(decisionMatch[1]);
    if (!txn) throw new HttpError(404, 'Request not found');
    if (txn.status !== 'pending') throw new HttpError(400, 'This request was already handled');

    db.transaction(() => {
      const updated = db
        .prepare("UPDATE transactions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(action === 'approve' ? 'completed' : 'rejected', nowIso(), txn.id);
      if (updated.changes !== 1) throw new HttpError(400, 'This request was already handled');

      if (txn.type === 'deposit' && action === 'approve') {
        db.prepare('UPDATE users SET capital = capital + ? WHERE id = ?').run(txn.amount, txn.user_id);
        payInviteBonus(db, txn.user_id, txn.amount);
      }
      if (txn.type === 'withdraw' && action === 'reject') {
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(txn.amount, txn.user_id);
      }
    })();

    const fresh = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txn.id);
    return sendJson(res, 200, { transaction: serializeTransaction(fresh) });
  }

  throw new HttpError(404, 'Not found');
}

/* ------------------------------- static -------------------------------- */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      if (pathname !== '/' && !path.extname(relative)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (indexErr, indexData) => {
          if (indexErr) return res.writeHead(404).end('Not found');
          res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-cache' });
          return res.end(indexData);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=3600',
      'Content-Length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

/* -------------------------------- server -------------------------------- */

function createServer(db) {
  return http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        db.prepare('SELECT 1').get();
        return sendJson(res, 200, { ok: true, time: nowIso() });
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(db, req, res, url);
      }
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message });
      }
      console.error('[server] unexpected error:', err);
      return sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  });
}

function resolveDataDir() {
  const candidates = [process.env.DATA_DIR, path.join(__dirname, '..', 'data')].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (err) {
      console.warn(`[server] data directory ${dir} is not writable, trying the next one`);
    }
  }
  throw new Error('No writable data directory is available');
}

function bootstrap() {
  const db = openDatabase(process.env.DB_FILE || path.join(resolveDataDir(), 'ship.db'));

  const adminPhone = (process.env.ADMIN_PHONE || '').replace(/[^\d]/g, '');
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminPhone && adminPassword.length >= 6) {
    const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(adminPhone);
    if (existing) {
      db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(
        hashPassword(adminPassword),
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO users (id, phone, name, password_hash, role, referral_code, created_at)
         VALUES (?, ?, ?, ?, 'admin', ?, ?)`,
      ).run(
        newId(),
        adminPhone,
        `Member ${adminPhone}`,
        hashPassword(adminPassword),
        uniqueReferralCode(db),
        nowIso(),
      );
    }
    console.log(`[server] admin account ready for ${adminPhone}`);
  }

  const server = createServer(db);
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => {
    console.log(`[server] Ship Transfer listening on 0.0.0.0:${port}`);
  });
  startScheduler(db);
  return server;
}

if (require.main === module) {
  bootstrap();
}

module.exports = { createServer, bootstrap, handleApi, buildConfig };
