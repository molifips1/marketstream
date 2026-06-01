const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "256kb" }));

// --- small helpers (hoisted: used across many routes) ---
function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Clamp text inputs so a client can't stuff a megabyte into a TEXT column.
// Parameterised queries stop injection, not oversized payloads.
function txt(v, max = 200) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// --- config from environment ---
// DATABASE_URL is provided by Railway when you reference the Postgres service.
// INGEST_TOKEN is a shared secret you set yourself; the extension must send it.
const { DATABASE_URL, INGEST_TOKEN, PORT = 3000 } = process.env;

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set");
  process.exit(1);
}
if (!INGEST_TOKEN) {
  console.error("FATAL: INGEST_TOKEN is not set");
  process.exit(1);
}

// SSL: Railway's private network (*.railway.internal) and local sockets need
// no SSL. Public Postgres URLs (proxy.rlwy.net etc.) do. You can force it with
// PGSSL=true/false if the auto-detection guesses wrong.
function wantsSsl(url) {
  if (process.env.PGSSL === "true") return true;
  if (process.env.PGSSL === "false") return false;
  if (!url) return false;
  if (url.includes("railway.internal")) return false; // private network
  if (url.includes("localhost") || url.includes("127.0.0.1") || url.includes("host=/")) return false;
  return true; // assume public TCP needs SSL
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: wantsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

// --- schema bootstrap: create the table on first boot ---
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bets (
      id            BIGSERIAL PRIMARY KEY,
      bet_id        TEXT,
      user_id       TEXT,
      username      TEXT,
      game          TEXT,
      currency      TEXT,
      amount        NUMERIC(20, 8),
      payout        NUMERIC(20, 8),
      multiplier    NUMERIC(20, 8),
      profit        NUMERIC(20, 8),
      is_free_game  BOOLEAN DEFAULT FALSE,
      won           BOOLEAN,
      demo          BOOLEAN,
      placed_at     TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Migration for databases created before user_id existed.
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS user_id TEXT;`);
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS session_id TEXT;`);
  // De-dupe protection: same spin from same user shouldn't insert twice.
  await pool.query(`DROP INDEX IF EXISTS bets_bet_id_uniq;`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bets_user_bet_uniq
    ON bets (user_id, bet_id) WHERE bet_id IS NOT NULL;
  `);

  // Unified per-session table holding EVERY game played. Engine games fill the
  // per-bet columns (bet_count, total_wagered, total_payout, pnl); native and
  // third-party games fill the balance-delta columns (net, start/end balance).
  // Columns not applicable to a given game type are left null.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      user_id        TEXT,
      username       TEXT,
      provider       TEXT,
      game           TEXT,
      currency       TEXT,
      tier           TEXT,
      demo           BOOLEAN,
      -- per-bet detail (engine games)
      bet_count      INTEGER DEFAULT 0,
      total_wagered  NUMERIC(20, 8) DEFAULT 0,
      total_payout   NUMERIC(20, 8) DEFAULT 0,
      pnl            NUMERIC(20, 8) DEFAULT 0,
      -- balance-delta detail (native / third-party games)
      net            NUMERIC(20, 8),
      start_balance  NUMERIC(20, 8),
      end_balance    NUMERIC(20, 8),
      started_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Migrate older sessions tables that lack the newer columns.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS provider TEXT;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tier TEXT;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS demo BOOLEAN;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS net NUMERIC(20, 8);`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS start_balance NUMERIC(20, 8);`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS end_balance NUMERIC(20, 8);`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ended BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_user_time
    ON sessions (user_id, updated_at DESC);
  `);

  // Deposits and withdrawals — money in/out, separate from gambling P&L.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id           BIGSERIAL PRIMARY KEY,
      tx_id        TEXT,
      user_id      TEXT,
      kind         TEXT,      -- 'deposit' | 'withdrawal'
      amount       NUMERIC(20, 8),
      currency     TEXT,
      status       TEXT,
      created_at   TIMESTAMPTZ,
      recorded_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_tx_uniq
    ON transactions (user_id, tx_id) WHERE tx_id IS NOT NULL;
  `);

  // Balance snapshots over time. Balance moves independently of bets
  // (deposits, withdrawals, native-game play), so it gets its own table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS balances (
      id           BIGSERIAL PRIMARY KEY,
      user_id      TEXT,
      username     TEXT,
      currency     TEXT,
      amount       NUMERIC(20, 8),
      recorded_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS balances_user_time
    ON balances (user_id, recorded_at DESC);
  `);
  console.log("DB ready");
}

// --- CORS so the browser extension can POST cross-origin ---
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- token check for write endpoints ---
function requireToken(req, res, next) {
  const auth = req.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token !== INGEST_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// --- lightweight per-token rate limit (no external dependency) ---
// Sliding window: cap requests per token per window. A few hundred/min is far
// more than legitimate use, but stops a token holder hammering thousands/sec.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 600; // requests per token per minute
const rateHits = new Map(); // token -> [timestamps]
function rateLimit(req, res, next) {
  const auth = req.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "anon";
  const now = Date.now();
  const arr = (rateHits.get(token) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    res.set("Retry-After", "60");
    return res.status(429).json({ error: "rate_limited" });
  }
  arr.push(now);
  rateHits.set(token, arr);
  next();
}
// Periodically clear empty buckets so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateHits) {
    const kept = v.filter((t) => now - t < RATE_WINDOW_MS);
    if (kept.length) rateHits.set(k, kept);
    else rateHits.delete(k);
  }
}, RATE_WINDOW_MS).unref?.();

app.get("/", (_req, res) => res.json({ ok: true, service: "stake-tracker-api" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Rate-limit everything below this line (health/root above are exempt so
// uptime checks and the connection test aren't throttled).
app.use(rateLimit);

// --- ingest one bet ---
app.post("/bets", requireToken, async (req, res) => {
  const b = req.body || {};
  try {
    const result = await pool.query(
      `INSERT INTO bets
         (bet_id, user_id, session_id, username, game, currency, amount, payout,
          multiplier, profit, is_free_game, won, demo, placed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (user_id, bet_id) WHERE bet_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        txt(b.betId, 80),
        txt(b.userId, 64),
        txt(b.sessionId, 64),
        txt(b.username, 80),
        txt(b.game, 120),
        txt(b.currency, 16),
        numOrNull(b.amount),
        numOrNull(b.payout),
        numOrNull(b.multiplier),
        numOrNull(b.profit),
        !!b.isFreeGame,
        b.won ?? null,
        b.demo ?? null,
        b.placedAt ? new Date(b.placedAt) : null,
      ]
    );

    // Only fold this bet into the session summary if it actually inserted
    // (rowCount 0 means it was a duplicate retry — don't double-count).
    if (result.rowCount === 1 && b.sessionId) {
      await pool.query(
        `INSERT INTO sessions
           (session_id, user_id, username, game, currency,
            bet_count, total_wagered, total_payout, pnl, updated_at)
         VALUES ($1,$2,$3,$4,$5, 1, $6, $7, $8, NOW())
         ON CONFLICT (session_id) DO UPDATE SET
           bet_count     = sessions.bet_count + 1,
           total_wagered = sessions.total_wagered + EXCLUDED.total_wagered,
           total_payout  = sessions.total_payout + EXCLUDED.total_payout,
           pnl           = sessions.pnl + EXCLUDED.pnl,
           username      = COALESCE(EXCLUDED.username, sessions.username),
           updated_at    = NOW()`,
        [
          b.sessionId,
          b.userId ?? null,
          b.username ?? null,
          b.game ?? null,
          b.currency ?? null,
          numOrNull(b.amount) ?? 0,
          numOrNull(b.payout) ?? 0,
          numOrNull(b.profit) ?? 0,
        ]
      );
    }

    res.json({ ok: true, inserted: result.rowCount, id: result.rows[0]?.id ?? null });
  } catch (err) {
    console.error("insert failed:", err.message);
    res.status(500).json({ error: "insert_failed" });
  }
});

// --- ingest one balance snapshot (array of {currency, amount}) ---
app.post("/balance", requireToken, async (req, res) => {
  const b = req.body || {};
  const list = Array.isArray(b.balances) ? b.balances : [];
  if (!list.length) return res.json({ ok: true, inserted: 0 });
  try {
    let inserted = 0;
    for (const item of list) {
      const amount = numOrNull(item.amount);
      if (amount == null) continue;
      await pool.query(
        `INSERT INTO balances (user_id, username, currency, amount)
         VALUES ($1,$2,$3,$4)`,
        [b.userId ?? null, b.username ?? null, item.currency ?? null, amount]
      );
      inserted++;
    }
    res.json({ ok: true, inserted });
  } catch (err) {
    console.error("balance insert failed:", err.message);
    res.status(500).json({ error: "insert_failed" });
  }
});

// --- simple read-back for sanity checking ---
// Optional ?user_id= filters to one user's rows (multi-tenant reads).
app.get("/bets", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const userId = txt(req.query.user_id, 64);
  try {
    const r = userId
      ? await pool.query(
          `SELECT * FROM bets WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
          [userId, limit]
        )
      : await pool.query(`SELECT * FROM bets ORDER BY id DESC LIMIT $1`, [limit]);
    res.json({ ok: true, count: r.rowCount, bets: r.rows });
  } catch (err) {
    console.error("bets query failed:", err.message);
    res.status(500).json({ error: "query_failed" });
  }
});

// --- upsert a game session (all providers) into the unified sessions table ---
app.post("/game-session", requireToken, async (req, res) => {
  const b = req.body || {};
  const sid = b.gsId || b.sessionId;
  if (!sid) return res.json({ ok: true, updated: 0 });
  try {
    await pool.query(
      `INSERT INTO sessions
         (session_id, user_id, provider, game, currency, tier, demo,
          net, start_balance, end_balance, started_at, ended, ended_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         net           = EXCLUDED.net,
         start_balance = COALESCE(sessions.start_balance, EXCLUDED.start_balance),
         end_balance   = EXCLUDED.end_balance,
         provider      = COALESCE(EXCLUDED.provider, sessions.provider),
         game          = COALESCE(EXCLUDED.game, sessions.game),
         currency      = COALESCE(EXCLUDED.currency, sessions.currency),
         tier          = COALESCE(EXCLUDED.tier, sessions.tier),
         demo          = COALESCE(EXCLUDED.demo, sessions.demo),
         ended         = sessions.ended OR EXCLUDED.ended,
         ended_at      = COALESCE(sessions.ended_at, EXCLUDED.ended_at),
         updated_at    = NOW()`,
      [
        txt(sid, 64),
        txt(b.userId, 64),
        txt(b.provider, 80),
        txt(b.game, 120),
        txt(b.currency, 16),
        txt(b.tier, 24),
        b.demo ?? null,
        numOrNull(b.net),
        numOrNull(b.startBalance),
        numOrNull(b.endBalance),
        b.startedAt ? new Date(b.startedAt) : null,
        !!b.ended,
        b.endedAt ? new Date(b.endedAt) : null,
      ]
    );
    res.json({ ok: true, updated: 1 });
  } catch (err) {
    console.error("game-session upsert failed:", err.message);
    res.status(500).json({ error: "upsert_failed" });
  }
});

// --- ingest a deposit/withdrawal ---
app.post("/transaction", requireToken, async (req, res) => {
  const b = req.body || {};
  try {
    const result = await pool.query(
      `INSERT INTO transactions
         (tx_id, user_id, kind, amount, currency, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, tx_id) WHERE tx_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        b.txId ?? null,
        b.userId ?? null,
        b.kind ?? null,
        numOrNull(b.amount),
        b.currency ?? null,
        b.status ?? null,
        b.createdAt ? new Date(b.createdAt) : null,
      ]
    );
    res.json({ ok: true, inserted: result.rowCount });
  } catch (err) {
    console.error("transaction insert failed:", err.message);
    res.status(500).json({ error: "insert_failed" });
  }
});

app.get("/transactions", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const userId = txt(req.query.user_id, 64);
  try {
    const r = userId
      ? await pool.query(
          `SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
          [userId, limit]
        )
      : await pool.query(`SELECT * FROM transactions ORDER BY id DESC LIMIT $1`, [limit]);
    res.json({ ok: true, count: r.rowCount, transactions: r.rows });
  } catch (err) {
    console.error("transactions query failed:", err.message);
    res.status(500).json({ error: "query_failed" });
  }
});

// Alias: /game-sessions now reads the unified sessions table (kept for
// backward compatibility — every game lives in `sessions`).
app.get("/game-sessions", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const userId = txt(req.query.user_id, 64);
  try {
    const r = userId
      ? await pool.query(
          `SELECT * FROM sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
          [userId, limit]
        )
      : await pool.query(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT $1`, [limit]);
    res.json({ ok: true, count: r.rowCount, sessions: r.rows });
  } catch (err) {
    console.error("game-sessions query failed:", err.message);
    res.status(500).json({ error: "query_failed" });
  }
});

app.get("/sessions", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const userId = txt(req.query.user_id, 64);
  try {
    const r = userId
      ? await pool.query(
          `SELECT * FROM sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`,
          [userId, limit]
        )
      : await pool.query(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT $1`, [limit]);
    res.json({ ok: true, count: r.rowCount, sessions: r.rows });
  } catch (err) {
    console.error("sessions query failed:", err.message);
    res.status(500).json({ error: "query_failed" });
  }
});

app.get("/balance", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const userId = txt(req.query.user_id, 64);
  try {
    const r = userId
      ? await pool.query(
          `SELECT * FROM balances WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
          [userId, limit]
        )
      : await pool.query(`SELECT * FROM balances ORDER BY id DESC LIMIT $1`, [limit]);
    res.json({ ok: true, count: r.rowCount, balances: r.rows });
  } catch (err) {
    console.error("balance query failed:", err.message);
    res.status(500).json({ error: "query_failed" });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`stake-tracker-api listening on ${PORT}`));
  })
  .catch((err) => {
    console.error("DB init failed:", err.message);
    process.exit(1);
  });
