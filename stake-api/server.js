const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "256kb" }));

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

  // Live per-session summary, updated on every (non-duplicate) bet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      user_id        TEXT,
      username       TEXT,
      game           TEXT,
      currency       TEXT,
      bet_count      INTEGER DEFAULT 0,
      total_wagered  NUMERIC(20, 8) DEFAULT 0,
      total_payout   NUMERIC(20, 8) DEFAULT 0,
      pnl            NUMERIC(20, 8) DEFAULT 0,
      started_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_user_time
    ON sessions (user_id, updated_at DESC);
  `);

  // Universal game sessions: one row per game opened, for ALL providers
  // (native, third-party, engine). Holds session-level net from balance
  // deltas — no per-bet detail, but every game is represented here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_sessions (
      gs_id          TEXT PRIMARY KEY,
      user_id        TEXT,
      provider       TEXT,
      game           TEXT,
      currency       TEXT,
      tier           TEXT,
      demo           BOOLEAN,
      net            NUMERIC(20, 8),
      start_balance  NUMERIC(20, 8),
      end_balance    NUMERIC(20, 8),
      started_at     TIMESTAMPTZ,
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS game_sessions_user_time
    ON game_sessions (user_id, started_at DESC);
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

app.get("/", (_req, res) => res.json({ ok: true, service: "stake-tracker-api" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

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
        b.betId ?? null,
        b.userId ?? null,
        b.sessionId ?? null,
        b.username ?? null,
        b.game ?? null,
        b.currency ?? null,
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
app.get("/bets", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  try {
    const r = await pool.query(
      `SELECT * FROM bets ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, count: r.rowCount, bets: r.rows });
  } catch (err) {
    res.status(500).json({ error: "query_failed" });
  }
});

// --- upsert a universal game session (all providers) ---
app.post("/game-session", requireToken, async (req, res) => {
  const b = req.body || {};
  if (!b.gsId) return res.json({ ok: true, updated: 0 });
  try {
    await pool.query(
      `INSERT INTO game_sessions
         (gs_id, user_id, provider, game, currency, tier, demo,
          net, start_balance, end_balance, started_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (gs_id) DO UPDATE SET
         net          = EXCLUDED.net,
         end_balance  = EXCLUDED.end_balance,
         game         = COALESCE(EXCLUDED.game, game_sessions.game),
         updated_at   = NOW()`,
      [
        b.gsId,
        b.userId ?? null,
        b.provider ?? null,
        b.game ?? null,
        b.currency ?? null,
        b.tier ?? null,
        b.demo ?? null,
        numOrNull(b.net),
        numOrNull(b.startBalance),
        numOrNull(b.endBalance),
        b.startedAt ? new Date(b.startedAt) : null,
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
  try {
    const r = await pool.query(
      `SELECT * FROM transactions ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, count: r.rowCount, transactions: r.rows });
  } catch (err) {
    res.status(500).json({ error: "query_failed" });
  }
});

app.get("/game-sessions", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  try {
    const r = await pool.query(
      `SELECT * FROM game_sessions ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, count: r.rowCount, gameSessions: r.rows });
  } catch (err) {
    res.status(500).json({ error: "query_failed" });
  }
});

app.get("/sessions", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  try {
    const r = await pool.query(
      `SELECT * FROM sessions ORDER BY updated_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, count: r.rowCount, sessions: r.rows });
  } catch (err) {
    res.status(500).json({ error: "query_failed" });
  }
});

app.get("/balance", requireToken, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  try {
    const r = await pool.query(
      `SELECT * FROM balances ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, count: r.rowCount, balances: r.rows });
  } catch (err) {
    res.status(500).json({ error: "query_failed" });
  }
});

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`stake-tracker-api listening on ${PORT}`));
  })
  .catch((err) => {
    console.error("DB init failed:", err.message);
    process.exit(1);
  });
