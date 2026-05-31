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
  // De-dupe protection: the same spin shouldn't insert twice on retry.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bets_bet_id_uniq
    ON bets (bet_id) WHERE bet_id IS NOT NULL;
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
         (bet_id, username, game, currency, amount, payout, multiplier,
          profit, is_free_game, won, demo, placed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (bet_id) WHERE bet_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        b.betId ?? null,
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
    res.json({ ok: true, inserted: result.rowCount, id: result.rows[0]?.id ?? null });
  } catch (err) {
    console.error("insert failed:", err.message);
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
