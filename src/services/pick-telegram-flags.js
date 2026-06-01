import pg from "pg";
import { buildPickIdentityKey, getPickDateKey } from "../utils/pick-identity.js";

const { Pool } = pg;

let pool = null;
let tableReady = false;

function getSslConfig() {
  return process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false;
}

function getPool() {
  if (pool) return pool;

  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: getSslConfig(),
      max: 4,
    });
    return pool;
  }

  pool = new Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "danypicks",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
    ssl: getSslConfig(),
    max: 4,
  });
  return pool;
}

async function withDbRetry(task, maxAttempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (!/deadlock detected/i.test(message) || attempt >= maxAttempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}

function resolvePickId(pick) {
  if (pick?.id == null || pick?.id === "") return null;
  const parsed = Number(pick.id);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

async function ensureTable() {
  if (tableReady) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS pick_telegram_sent (
      pick_date DATE NOT NULL,
      identity_key TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('verde', 'amarillo')),
      pick_id BIGINT REFERENCES picks(id) ON DELETE CASCADE,
      completeness SMALLINT NOT NULL DEFAULT 0,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pick_date, identity_key, tier)
    );
    CREATE INDEX IF NOT EXISTS idx_pick_telegram_sent_pick_id ON pick_telegram_sent (pick_id);
    ALTER TABLE pick_telegram_sent ADD COLUMN IF NOT EXISTS completeness SMALLINT NOT NULL DEFAULT 0;
  `);
  tableReady = true;
}

export async function getTelegramSentState(pick) {
  await ensureTable();
  const pickDate = getPickDateKey(pick);
  const identityKey = buildPickIdentityKey(pick);

  const { rows } = await withDbRetry(() => getPool().query(
    `
      SELECT tier, completeness
      FROM pick_telegram_sent
      WHERE pick_date = $1
        AND identity_key = $2
    `,
    [pickDate, identityKey]
  ));

  const state = {
    verde: false,
    amarillo: false,
    verdeCompleteness: 0,
    amarilloCompleteness: 0,
  };

  for (const row of rows) {
    if (row.tier === "verde") {
      state.verde = true;
      state.verdeCompleteness = Number(row.completeness || 0);
    }
    if (row.tier === "amarillo") {
      state.amarillo = true;
      state.amarilloCompleteness = Number(row.completeness || 0);
    }
  }

  return { pickDate, identityKey, state };
}

export async function markTelegramSent(pick, tier, completeness = 0) {
  await ensureTable();
  const pickDate = getPickDateKey(pick);
  const identityKey = buildPickIdentityKey(pick);
  const pickId = resolvePickId(pick);

  await withDbRetry(() => getPool().query(
    `
      INSERT INTO pick_telegram_sent (pick_date, identity_key, tier, pick_id, completeness)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (pick_date, identity_key, tier) DO UPDATE
      SET pick_id = COALESCE(EXCLUDED.pick_id, pick_telegram_sent.pick_id),
          completeness = GREATEST(pick_telegram_sent.completeness, EXCLUDED.completeness),
          sent_at = NOW()
    `,
    [pickDate, identityKey, tier, pickId, Number(completeness) || 0]
  ));
}

export async function clearTelegramFlagsForPick(pickId) {
  if (!pickId) return 0;
  await ensureTable();
  const result = await getPool().query(`DELETE FROM pick_telegram_sent WHERE pick_id = $1`, [Number(pickId)]);
  return result.rowCount || 0;
}
