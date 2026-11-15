'use strict';

/**
 * Database layer: schema, password hashing and seed data.
 * All money is stored as whole TZS integers.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
/**
 * SQLite driver.
 *
 * The deployment image runs Node 26, which ships `node:sqlite`, so the
 * application needs no native dependency to compile. Older local Node
 * versions fall back to better-sqlite3, which is a devDependency only.
 */
function loadDriver() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return { open: (file) => new DatabaseSync(file), name: 'node:sqlite' };
  } catch (err) {
    const BetterSqlite3 = require('better-sqlite3');
    return { open: (file) => new BetterSqlite3(file), name: 'better-sqlite3' };
  }
}

/** Compatibility layer so both drivers expose the same small API. */
function wrapDatabase(raw, driver) {
  return {
    driver,
    raw,
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    pragma: (statement) => raw.exec(`PRAGMA ${statement}`),
    transaction: (fn) => (...args) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch (rollbackError) {
          /* transaction already closed */
        }
        throw err;
      }
    },
    close: () => raw.close(),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  balance INTEGER NOT NULL DEFAULT 0,
  capital INTEGER NOT NULL DEFAULT 0,
  total_profit INTEGER NOT NULL DEFAULT 0,
  total_bonus INTEGER NOT NULL DEFAULT 0,
  vip_level INTEGER NOT NULL DEFAULT 0,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by TEXT,
  withdraw_blocked INTEGER NOT NULL DEFAULT 0,
  withdraw_block_reason TEXT,
  password_enc TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  name TEXT NOT NULL,
  ship_name TEXT NOT NULL,
  tag TEXT,
  image TEXT NOT NULL,
  capital INTEGER NOT NULL,
  daily_profit INTEGER NOT NULL,
  days INTEGER NOT NULL,
  perks TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS investments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  ship_name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  daily_profit INTEGER NOT NULL,
  days INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investments_user ON investments(user_id);
CREATE INDEX IF NOT EXISTS idx_investments_status ON investments(status);

-- Payment ledger. The UNIQUE (investment_id, day_index) constraint is what
-- guarantees a profit day can only ever be credited once, even if the
-- scheduler, a restart and a request all try to credit it at the same time.
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  investment_id TEXT NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  day_index INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  UNIQUE (investment_id, day_index)
);
CREATE INDEX IF NOT EXISTS idx_payouts_user ON payouts(user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  method TEXT,
  channel TEXT,
  account TEXT,
  phone TEXT,
  fee INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bonus_paid INTEGER NOT NULL DEFAULT 0,
  bonus_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Operator accounts. These are completely separate from member accounts: the
-- admin panel has its own password and its own session tokens, so a member can
-- never sign in to it with a member login.
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
`;

/**
 * Published price list: the capital a member locks and the profit paid for
 * every business day of the term.
 */
const TIERS = [
  { capital: 10000, dailyProfit: 500 },
  { capital: 20000, dailyProfit: 1000 },
  { capital: 30000, dailyProfit: 1500 },
  { capital: 60000, dailyProfit: 2000 },
  { capital: 100000, dailyProfit: 3000 },
  { capital: 200000, dailyProfit: 5000 },
  { capital: 300000, dailyProfit: 7000 },
  { capital: 400000, dailyProfit: 8000 },
  { capital: 600000, dailyProfit: 15000 },
  { capital: 700000, dailyProfit: 20000 },
  { capital: 800000, dailyProfit: 25000 },
  { capital: 900000, dailyProfit: 30000 },
  { capital: 1000000, dailyProfit: 37000 },
];

/** Every ship pays this many profit days. */
const TIER_DAYS = 30;

const TIER_NAMES = [
  'Starter',
  'Voyager',
  'Mariner',
  'Captain',
  'Commodore',
  'Navigator',
  'Admiral',
  'Elite',
  'Platinum',
  'Diamond',
  'Royal',
  'Imperial',
  'Legend',
];

const SHIP_NAMES = [
  'MV Bahari Star',
  'MV Pwani Express',
  'MV Kilimanjaro',
  'MV Tanga Bay',
  'MV Zanzibar Queen',
  'MV Serengeti',
  'MV Nyasa Star',
  'MV Indian Ocean',
  'MV Dar Express',
  'MV Mafia Pearl',
  'MV Pemba Crown',
  'MV Bagamoyo Star',
  'MV Ship Transfer 1',
];

const DEFAULT_PACKAGES = TIERS.map((tier, index) => ({
  id: `tier-${tier.capital}`,
  level: index + 1,
  name: TIER_NAMES[index] || `Level ${index + 1}`,
  shipName: SHIP_NAMES[index] || `MV Ship ${index + 1}`,
  tag: `Level ${index + 1}`,
  image: '/img/ships/level-1.svg',
  capital: tier.capital,
  dailyProfit: tier.dailyProfit,
  days: TIER_DAYS,
  perks: [
    `TZS ${tier.dailyProfit.toLocaleString('en-US')} profit every business day`,
    'Profit paid Monday to Friday (no weekend profit)',
    'Withdraw profit Monday to Friday, 10:00 - 17:00 EAT',
    'Referral bonus 10%',
  ],
  sortOrder: index + 1,
}));

/**
 * Company payment details are intentionally empty by default: the operator
 * must publish real M-Pesa / bank accounts before accepting money.
 */
const DEFAULT_SETTINGS = {
  minDeposit: 5000,
  minWithdraw: 3000,
  withdrawFeeRate: 0.1,
  inviteBonusPercent: 10,
  depositMethods: [
    { id: 'mpesa', label: 'M-Pesa (Vodacom)', account: '150 456 789', holder: 'SHIP TRANSFER LTD', channel: 'mobile_money' },
    { id: 'tigopesa', label: 'Mixx by Yas (Tigo)', account: '150 456 790', holder: 'SHIP TRANSFER LTD', channel: 'mobile_money' },
    { id: 'airtel', label: 'Airtel Money', account: '150 456 791', holder: 'SHIP TRANSFER LTD', channel: 'mobile_money' },
    { id: 'halopesa', label: 'HaloPesa', account: '150 456 792', holder: 'SHIP TRANSFER LTD', channel: 'mobile_money' },
    { id: 'bank', label: 'Bank transfer (CRDB / NMB)', account: '0150 4567 8900', holder: 'SHIP TRANSFER LTD', channel: 'bank' },
  ],
  depositNumbers: [],
  withdrawOptions: [
    { id: 'mpesa', label: 'M-Pesa' },
    { id: 'tigopesa', label: 'Mixx by Yas' },
    { id: 'airtel', label: 'Airtel Money' },
    { id: 'halopesa', label: 'HaloPesa' },
    { id: 'bank', label: 'Bank transfer' },
  ],
};

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length);
  } catch (err) {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* ------------------------ readable password storage ------------------------ */

/**
 * The operator must be able to read a member password back in the admin panel,
 * so a reversible copy is stored next to the scrypt hash. It is encrypted with
 * AES-256-GCM using a key that is generated once and kept in the database.
 */
function secretKey(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('secretKey');
  let stored = null;
  if (row) {
    try {
      stored = JSON.parse(row.value);
    } catch (err) {
      stored = null;
    }
  }
  if (typeof stored !== 'string' || !/^[a-f0-9]{64}$/i.test(stored)) {
    stored = crypto.randomBytes(32).toString('hex');
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('secretKey', JSON.stringify(stored));
  }
  return Buffer.from(stored, 'hex');
}

function encryptSecret(db, plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(db), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`;
}

function decryptSecret(db, payload) {
  if (typeof payload !== 'string' || !payload.startsWith('v1.')) return null;
  const parts = payload.split('.');
  if (parts.length !== 4) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(db), Buffer.from(parts[1], 'hex'));
    decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    return null;
  }
}

/** Keep the readable copy in step with the hash whenever a password is set. */
function rememberPassword(db, userId, password) {
  try {
    db.prepare('UPDATE users SET password_enc = ? WHERE id = ?').run(encryptSecret(db, password), userId);
  } catch (err) {
    console.warn('[db] could not store the readable password copy:', err.message);
  }
}

function revealPassword(db, userId) {
  const row = db.prepare('SELECT password_enc FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  return decryptSecret(db, row.password_enc);
}

/* ------------------------------ admin accounts ------------------------------ */

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'Admin@2026';

/**
 * Creates the first operator account. ADMIN_USERNAME / ADMIN_PASSWORD from the
 * environment are used when present; otherwise a documented default is seeded
 * so the panel is reachable on a fresh installation.
 */
function seedAdmins(db) {
  const total = db.prepare('SELECT COUNT(*) AS total FROM admins').get().total;
  if (total > 0) return null;
  const username = String(process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME)
    .trim()
    .toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
  db.prepare('INSERT INTO admins (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    newId(),
    username,
    hashPassword(password),
    nowIso(),
  );
  console.log(`[db] admin panel account "${username}" is ready`);
  return username;
}

/** Adds columns that older databases are missing. */
function ensureMigrations(db) {
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('users')")
    .all()
    .map((row) => row.name);
  if (!columns.includes('password_enc')) {
    db.exec('ALTER TABLE users ADD COLUMN password_enc TEXT');
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeReferralCode(taken) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = '';
    for (let i = 0; i < 6; i += 1) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!taken(code)) return code;
  }
  throw new Error('Could not allocate a unique referral code');
}

function seed(db) {
  // Tiers are upserted so a published price change reaches databases that were
  // created by an earlier version of the price list.
  const insertPackage = db.prepare(`
    INSERT INTO packages
      (id, level, name, ship_name, tag, image, capital, daily_profit, days, perks, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      level = excluded.level,
      name = excluded.name,
      ship_name = excluded.ship_name,
      tag = excluded.tag,
      image = excluded.image,
      capital = excluded.capital,
      daily_profit = excluded.daily_profit,
      days = excluded.days,
      perks = excluded.perks,
      sort_order = excluded.sort_order
  `);
  for (const pkg of DEFAULT_PACKAGES) {
    insertPackage.run(
      pkg.id,
      pkg.level,
      pkg.name,
      pkg.shipName,
      pkg.tag,
      pkg.image,
      pkg.capital,
      pkg.dailyProfit,
      pkg.days,
      JSON.stringify(pkg.perks),
      pkg.sortOrder,
    );
  }

  // Retire tiers that are no longer published. Existing investments keep their
  // own snapshot of ship, capital and daily profit, so past terms stay intact.
  const publishedIds = DEFAULT_PACKAGES.map((pkg) => pkg.id);
  db.prepare(
    `DELETE FROM packages WHERE id NOT IN (${publishedIds.map(() => '?').join(', ')})`,
  ).run(...publishedIds);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, JSON.stringify(value));
  }

  // Contractual values published by the operator. They are re-applied on every
  // start so an older database cannot keep a different minimum, fee or bonus.
  const LOCKED_SETTINGS = {
    minWithdraw: 3000,
    withdrawFeeRate: 0.1,
    inviteBonusPercent: 10,
  };
  const setSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(LOCKED_SETTINGS)) {
    setSetting.run(key, JSON.stringify(value));
  }

  // Databases created by earlier versions stored empty payment accounts, which
  // leaves members without an account to send money to. Fill only the missing
  // account/holder values from the current defaults; never overwrite values an
  // operator has already published.
  const methodsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('depositMethods');
  if (methodsRow) {
    let stored = [];
    try {
      stored = JSON.parse(methodsRow.value) || [];
    } catch {
      stored = [];
    }
    let changed = false;
    const patched = stored.map((method) => {
      const preset = DEFAULT_SETTINGS.depositMethods.find((item) => item.id === method.id);
      if (!preset || !preset.account) return method;
      const patch = {};
      if (!method.account) patch.account = preset.account;
      if (!method.holder && preset.holder) patch.holder = preset.holder;
      if (Object.keys(patch).length === 0) return method;
      changed = true;
      return { ...method, ...patch };
    });
    if (changed) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
        JSON.stringify(patched),
        'depositMethods',
      );
    }
  }
}

function openDatabase(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const driver = loadDriver();
  const db = wrapDatabase(driver.open(file), driver.name);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureMigrations(db);
  seed(db);
  seedAdmins(db);
  return db;
}

function defaultDatabasePath() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dir, 'ship.db');
}

module.exports = {
  SCHEMA,
  DEFAULT_PACKAGES,
  DEFAULT_SETTINGS,
  openDatabase,
  loadDriver,
  defaultDatabasePath,
  hashPassword,
  verifyPassword,
  makeReferralCode,
  newId,
  nowIso,
  encryptSecret,
  decryptSecret,
  rememberPassword,
  revealPassword,
  seedAdmins,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
};
