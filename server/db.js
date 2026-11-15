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
`;

const DEFAULT_PACKAGES = [
  {
    id: 'level-1',
    level: 1,
    name: 'Starter',
    shipName: 'MV Bahari Star',
    tag: 'Entry',
    image: '/img/ships/level-1.svg',
    capital: 50000,
    dailyProfit: 3000,
    days: 30,
    perks: ['Daily profit Monday to Friday', 'Profit withdrawable any business day', 'Referral bonus 10%'],
    sortOrder: 1,
  },
  {
    id: 'level-2',
    level: 2,
    name: 'Voyager',
    shipName: 'MV Pwani Express',
    tag: 'Popular',
    image: '/img/ships/level-1.svg',
    capital: 250000,
    dailyProfit: 17500,
    days: 30,
    perks: ['Higher daily profit', 'Priority payout queue', 'Referral bonus 10%'],
    sortOrder: 2,
  },
  {
    id: 'level-3',
    level: 3,
    name: 'Commodore',
    shipName: 'MV Zanzibar Queen',
    tag: 'Premium',
    image: '/img/ships/level-1.svg',
    capital: 1000000,
    dailyProfit: 80000,
    days: 30,
    perks: ['Top daily profit', 'Dedicated account manager', 'Referral bonus 10%'],
    sortOrder: 3,
  },
];

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
  const insertPackage = db.prepare(`
    INSERT OR IGNORE INTO packages
      (id, level, name, ship_name, tag, image, capital, daily_profit, days, perks, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, JSON.stringify(value));
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
  seed(db);
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
};
