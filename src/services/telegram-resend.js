import pg from "pg";
import { getPicks } from "./picks-db.js";
import { notifyNewPickTelegram } from "./telegram-notifier.js";
import { isPickEligibleForTelegram } from "../utils/pick-timing.js";

const { Pool } = pg;

let pool = null;

function getPool() {
  if (pool) return pool;
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
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
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    max: 4,
  });
  return pool;
}

export async function clearTelegramFlags({ verdeOnly = false } = {}) {
  const sql = verdeOnly
    ? "DELETE FROM pick_telegram_sent WHERE tier = 'verde'"
    : "TRUNCATE pick_telegram_sent";
  const result = await getPool().query(sql);
  return result.rowCount ?? 0;
}

export async function resendPendingTrackerPicks({ verdeOnly = false } = {}) {
  const picks = await getPicks({ resultado: "pendiente", limit: 500 });
  const tiers = verdeOnly ? new Set(["verde"]) : new Set(["verde", "amarillo"]);
  const pending = picks.filter((pick) => tiers.has(String(pick?.estado_color || "").toLowerCase()));
  // Pre-filtro rápido (elimina los claramente no elegibles al inicio)
  const preFiltered = pending.filter((pick) => isPickEligibleForTelegram(pick));

  let sent = 0;
  let skippedLate = 0;
  for (const pick of preFiltered) {
    // Re-validar en el momento del envío: el partido puede haber empezado
    // mientras iteramos la lista (el resend puede tardar minutos con 500 picks)
    if (!isPickEligibleForTelegram(pick)) {
      skippedLate += 1;
      continue;
    }
    const ok = await notifyNewPickTelegram(pick);
    if (ok) sent += 1;
  }
  return {
    total: pending.length,
    eligible: preFiltered.length,
    skipped: pending.length - preFiltered.length + skippedLate,
    skippedLate,
    sent,
  };
}
