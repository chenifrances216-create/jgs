'use strict';

/**
 * Admin panel API.
 *
 * The panel is completely independent from the member application:
 *  - operator accounts live in the `admins` table (not in `users`),
 *  - sessions live in `admin_sessions` and use `adm_<64 hex>` tokens,
 *  - every route below rejects a member token.
 *
 * Responsibilities: approve deposits/withdrawals, list members split into
 * depositors/renters and registered-only accounts, credit or debit a member
 * balance, show a member password, block withdrawals, delete accounts and
 * publish the deposit numbers members pay into.
 */

const crypto = require('node:crypto');

const {
  newId,
  nowIso,
  hashPassword,
  verifyPassword,
  revealPassword,
  rememberPassword,
} = require('./db');

const ADMIN_TOKEN_PATTERN = /^Bearer\s+(adm_[0-9a-f]{64})$/i;

/* ------------------------------ admin auth ------------------------------ */

function createAdminSession(db, adminId) {
  const token = `adm_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  db.prepare('INSERT INTO admin_sessions (token, admin_id, created_at) VALUES (?, ?, ?)').run(
    token,
    adminId,
    nowIso(),
  );
  return token;
}

function authenticateAdmin(db, req) {
  const match = ADMIN_TOKEN_PATTERN.exec(String(req.headers.authorization || ''));
  if (!match) throw new AdminError(401, 'Admin sign-in required');
  const admin = db
    .prepare('SELECT a.* FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?')
    .get(match[1]);
  if (!admin) throw new AdminError(401, 'Admin session expired. Please sign in again.');
  return admin;
}

class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.isAdminError = true;
  }
}

/* ------------------------------- helpers -------------------------------- */

function amountOf(value, label) {
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AdminError(400, `${label} must be a positive amount`);
  }
  return amount;
}

function memberView(row) {
  const deposited = Number(row.deposited || 0);
  const activeCapital = Number(row.active_capital || 0);
  const activeCount = Number(row.active_count || 0);
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    createdAt: row.created_at,
    balance: row.balance,
    capital: row.capital,
    totalProfit: row.total_profit,
    totalBonus: row.total_bonus,
    profitPaid: Number(row.profit_paid || 0),
    deposited,
    activeCapital,
    activeInvestments: activeCount,
    withdrawBlocked: Boolean(row.withdraw_blocked),
    withdrawBlockReason: row.withdraw_block_reason || '',
    group: deposited > 0 || activeCapital > 0 ? 'active' : 'registered',
  };
}

const MEMBER_SELECT = `
  SELECT u.*,
    (SELECT COALESCE(SUM(t.amount), 0) FROM transactions t
      WHERE t.user_id = u.id AND t.type = 'deposit' AND t.status = 'completed') AS deposited,
    (SELECT COALESCE(SUM(i.amount), 0) FROM investments i
      WHERE i.user_id = u.id AND i.status = 'active') AS active_capital,
    (SELECT COUNT(*) FROM investments i
      WHERE i.user_id = u.id AND i.status = 'active') AS active_count,
    (SELECT COALESCE(SUM(p.amount), 0) FROM payouts p WHERE p.user_id = u.id) AS profit_paid
  FROM users u
`;

function findMember(db, id) {
  const row = db.prepare(`${MEMBER_SELECT} WHERE u.id = ?`).get(id);
  if (!row) throw new AdminError(404, 'Member not found');
  return row;
}

function sanitizeMethods(input) {
  if (!Array.isArray(input)) throw new AdminError(400, 'Deposit methods must be a list');
  const seen = new Set();
  const methods = [];
  input.slice(0, 12).forEach((item, index) => {
    const label = String((item && item.label) || '').trim().slice(0, 60);
    const account = String((item && item.account) || '').trim().slice(0, 60);
    if (!label || !account) return;
    let id = String((item && item.id) || `method-${index + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32);
    if (!id || seen.has(id)) id = `method-${index + 1}-${seen.size}`;
    seen.add(id);
    methods.push({
      id,
      label,
      account,
      holder: String((item && item.holder) || '').trim().slice(0, 80),
      channel: item && item.channel === 'bank' ? 'bank' : 'mobile_money',
    });
  });
  if (!methods.length) throw new AdminError(400, 'Keep at least one deposit account with a number');
  return methods;
}

function sanitizeNumbers(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new AdminError(400, 'Extra numbers must be a list');
  return input
    .slice(0, 12)
    .map((item, index) => {
      const number = String((item && (item.number || item.account)) || '').trim().slice(0, 60);
      if (!number) return null;
      return {
        id: String((item && item.id) || `number-${index + 1}`).slice(0, 40),
        label: String((item && item.label) || 'Deposit number').trim().slice(0, 60),
        number,
      };
    })
    .filter(Boolean);
}

/* -------------------------------- routes -------------------------------- */

async function handleAdminApi(db, req, res, url, deps) {
  const { sendJson, readJson, getSettings, serializeTransaction, serializeUser, payInviteBonus } = deps;
  const pathname = url.pathname;
  const method = req.method || 'GET';

  try {
    /* ---- sign in ---- */

    if (pathname === '/api/admin/login' && method === 'POST') {
      const body = await readJson(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
      if (!admin || !verifyPassword(password, admin.password_hash)) {
        throw new AdminError(401, 'Wrong admin username or password');
      }
      db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(nowIso(), admin.id);
      return sendJson(res, 200, {
        token: createAdminSession(db, admin.id),
        admin: { username: admin.username },
      });
    }

    /* Everything below needs an admin token. */

    if (pathname === '/api/admin/session' && method === 'GET') {
      const admin = authenticateAdmin(db, req);
      return sendJson(res, 200, { admin: { username: admin.username } });
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      const match = ADMIN_TOKEN_PATTERN.exec(String(req.headers.authorization || ''));
      if (match) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(match[1]);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/password' && method === 'POST') {
      const admin = authenticateAdmin(db, req);
      const body = await readJson(req);
      if (!verifyPassword(String(body.currentPassword || ''), admin.password_hash)) {
        throw new AdminError(400, 'Current admin password is wrong');
      }
      const next = String(body.newPassword || '');
      if (next.length < 8) throw new AdminError(400, 'New password must be at least 8 characters');
      db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), admin.id);
      db.prepare('DELETE FROM admin_sessions WHERE admin_id = ? AND token != ?').run(
        admin.id,
        ADMIN_TOKEN_PATTERN.exec(String(req.headers.authorization || ''))[1],
      );
      return sendJson(res, 200, { ok: true });
    }

    /* ---- dashboard ---- */

    if (pathname === '/api/admin/overview' && method === 'GET') {
      authenticateAdmin(db, req);
      const totals = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM users) AS members,
             (SELECT COUNT(*) FROM transactions WHERE type = 'deposit' AND status = 'pending') AS pending_deposits,
             (SELECT COUNT(*) FROM transactions WHERE type = 'withdraw' AND status = 'pending') AS pending_withdrawals,
             (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'deposit' AND status = 'completed') AS deposited,
             (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'withdraw' AND status = 'completed') AS withdrawn,
             (SELECT COALESCE(SUM(amount), 0) FROM payouts) AS profit_paid`,
        )
        .get();

      const pending = db
        .prepare(
          `SELECT t.*, u.name AS user_name, u.phone AS user_phone
             FROM transactions t JOIN users u ON u.id = t.user_id
            WHERE t.status = 'pending' AND t.type IN ('deposit', 'withdraw')
            ORDER BY t.created_at ASC LIMIT 100`,
        )
        .all()
        .map((row) => ({
          ...serializeTransaction(row),
          user: { id: row.user_id, name: row.user_name, phone: row.user_phone },
        }));

      const members = db
        .prepare(`${MEMBER_SELECT} ORDER BY u.created_at DESC`)
        .all()
        .map(memberView);

      return sendJson(res, 200, {
        stats: {
          members: Number(totals.members || 0),
          depositors: members.filter((m) => m.group === 'active').length,
          registeredOnly: members.filter((m) => m.group === 'registered').length,
          pendingDeposits: Number(totals.pending_deposits || 0),
          pendingWithdrawals: Number(totals.pending_withdrawals || 0),
          totalDeposited: Number(totals.deposited || 0),
          totalWithdrawn: Number(totals.withdrawn || 0),
          totalProfitPaid: Number(totals.profit_paid || 0),
        },
        pending,
      });
    }

    /* ---- deposits and withdrawals ---- */

    if (pathname === '/api/admin/requests' && method === 'GET') {
      authenticateAdmin(db, req);
      const type = url.searchParams.get('type');
      const status = url.searchParams.get('status') || 'pending';
      const clauses = ["t.type IN ('deposit', 'withdraw')"];
      const params = [];
      if (type === 'deposit' || type === 'withdraw') {
        clauses.push('t.type = ?');
        params.push(type);
      }
      if (status === 'pending' || status === 'completed' || status === 'rejected') {
        clauses.push('t.status = ?');
        params.push(status);
      }
      const rows = db
        .prepare(
          `SELECT t.*, u.name AS user_name, u.phone AS user_phone
             FROM transactions t JOIN users u ON u.id = t.user_id
            WHERE ${clauses.join(' AND ')}
            ORDER BY t.created_at DESC LIMIT 200`,
        )
        .all(...params)
        .map((row) => ({
          ...serializeTransaction(row),
          user: { id: row.user_id, name: row.user_name, phone: row.user_phone },
        }));
      return sendJson(res, 200, { requests: rows });
    }

    const decisionMatch = /^\/api\/admin\/requests\/([^/]+)\/decision$/.exec(pathname);
    if (decisionMatch && method === 'POST') {
      authenticateAdmin(db, req);
      const body = await readJson(req);
      const action = String(body.action || '');
      if (action !== 'approve' && action !== 'reject') throw new AdminError(400, 'Unknown decision');

      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(decisionMatch[1]);
      if (!txn) throw new AdminError(404, 'Request not found');
      if (txn.type !== 'deposit' && txn.type !== 'withdraw') {
        throw new AdminError(400, 'This ledger entry is not a deposit or withdrawal');
      }
      if (txn.status !== 'pending') throw new AdminError(400, 'This request was already handled');

      db.transaction(() => {
        // The status guard makes a decision strictly one-shot: a double click,
        // a retry or two admins working at once cannot pay twice.
        const updated = db
          .prepare("UPDATE transactions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
          .run(action === 'approve' ? 'completed' : 'rejected', nowIso(), txn.id);
        if (updated.changes !== 1) throw new AdminError(400, 'This request was already handled');

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

    /* ---- members ---- */

    if (pathname === '/api/admin/users' && method === 'GET') {
      authenticateAdmin(db, req);
      const filter = String(url.searchParams.get('filter') || 'all');
      const search = String(url.searchParams.get('q') || '').trim().toLowerCase();
      let members = db
        .prepare(`${MEMBER_SELECT} ORDER BY u.created_at DESC`)
        .all()
        .map(memberView);
      if (filter === 'active' || filter === 'registered') {
        members = members.filter((member) => member.group === filter);
      }
      if (search) {
        members = members.filter(
          (member) =>
            member.phone.includes(search) ||
            String(member.name || '').toLowerCase().includes(search),
        );
      }
      return sendJson(res, 200, { members, filter });
    }

    const memberPasswordMatch = /^\/api\/admin\/users\/([^/]+)\/password$/.exec(pathname);
    if (memberPasswordMatch && method === 'GET') {
      authenticateAdmin(db, req);
      const member = findMember(db, memberPasswordMatch[1]);
      const password = revealPassword(db, member.id);
      return sendJson(res, 200, {
        id: member.id,
        phone: member.phone,
        password,
        available: Boolean(password),
      });
    }

    const memberBalanceMatch = /^\/api\/admin\/users\/([^/]+)\/balance$/.exec(pathname);
    if (memberBalanceMatch && method === 'POST') {
      authenticateAdmin(db, req);
      const member = findMember(db, memberBalanceMatch[1]);
      const body = await readJson(req);
      const direction = String(body.direction || 'add') === 'subtract' ? 'subtract' : 'add';
      const amount = amountOf(body.amount, 'Amount');
      const note = String(body.note || '').trim().slice(0, 200);

      if (direction === 'subtract') {
        const debited = db
          .prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
          .run(amount, member.id, amount);
        if (debited.changes !== 1) {
          throw new AdminError(400, 'The member balance is smaller than this amount');
        }
      } else {
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, member.id);
      }

      db.prepare(
        `INSERT INTO transactions (id, user_id, type, label, amount, status, note, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      ).run(
        newId(),
        member.id,
        direction === 'add' ? 'admin_credit' : 'admin_debit',
        direction === 'add' ? 'Admin added balance' : 'Admin reduced balance',
        amount,
        note || 'Adjusted from the admin panel',
        nowIso(),
        nowIso(),
      );

      const fresh = findMember(db, member.id);
      return sendJson(res, 200, { member: memberView(fresh), direction, amount });
    }

    const memberBlockMatch = /^\/api\/admin\/users\/([^/]+)\/withdraw-block$/.exec(pathname);
    if (memberBlockMatch && method === 'POST') {
      authenticateAdmin(db, req);
      const member = findMember(db, memberBlockMatch[1]);
      const body = await readJson(req);
      const blocked = Boolean(body.blocked);
      const reason = String(body.reason || '').trim().slice(0, 160);
      db.prepare('UPDATE users SET withdraw_blocked = ?, withdraw_block_reason = ? WHERE id = ?').run(
        blocked ? 1 : 0,
        blocked ? reason || 'Withdrawals are blocked on this account' : null,
        member.id,
      );
      const fresh = findMember(db, member.id);
      return sendJson(res, 200, { member: memberView(fresh) });
    }

    const memberDeleteMatch = /^\/api\/admin\/users\/([^/]+)\/delete$/.exec(pathname);
    if (memberDeleteMatch && method === 'POST') {
      authenticateAdmin(db, req);
      const member = findMember(db, memberDeleteMatch[1]);
      const body = await readJson(req);
      const confirm = String(body.confirmPhone || '').replace(/\D/g, '');
      if (confirm !== member.phone) {
        throw new AdminError(400, 'Type the member phone number to confirm the deletion');
      }
      // Sessions, transactions, investments, payouts and referrals are removed
      // by the ON DELETE CASCADE rules.
      db.prepare('DELETE FROM users WHERE id = ?').run(member.id);
      return sendJson(res, 200, { ok: true, deleted: member.phone });
    }

    /* ---- deposit numbers ---- */

    if (pathname === '/api/admin/settings' && method === 'GET') {
      authenticateAdmin(db, req);
      const settings = getSettings(db);
      return sendJson(res, 200, {
        depositMethods: settings.depositMethods || [],
        depositNumbers: settings.depositNumbers || [],
      });
    }

    if (pathname === '/api/admin/settings' && method === 'PUT') {
      authenticateAdmin(db, req);
      const body = await readJson(req);
      const methods = sanitizeMethods(body.depositMethods);
      const numbers = sanitizeNumbers(body.depositNumbers);
      const upsert = db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      db.transaction(() => {
        upsert.run('depositMethods', JSON.stringify(methods));
        upsert.run('depositNumbers', JSON.stringify(numbers));
      })();
      return sendJson(res, 200, { depositMethods: methods, depositNumbers: numbers });
    }

    /* ---- member detail ---- */

    const memberMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
    if (memberMatch && method === 'GET') {
      authenticateAdmin(db, req);
      const member = findMember(db, memberMatch[1]);
      const transactions = db
        .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 60')
        .all(member.id)
        .map(serializeTransaction);
      const investments = db
        .prepare('SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC LIMIT 30')
        .all(member.id)
        .map((row) => ({
          id: row.id,
          shipName: row.ship_name,
          amount: row.amount,
          dailyProfit: row.daily_profit,
          days: row.days,
          status: row.status,
          startedAt: row.started_at,
        }));
      return sendJson(res, 200, {
        member: memberView(member),
        user: serializeUser(db, db.prepare('SELECT * FROM users WHERE id = ?').get(member.id)),
        transactions,
        investments,
      });
    }

    return false;
  } catch (err) {
    if (err && err.isAdminError) {
      sendJson(res, err.status, { error: err.message });
      return true;
    }
    throw err;
  }
}

module.exports = { handleAdminApi, authenticateAdmin, AdminError, ADMIN_TOKEN_PATTERN };
