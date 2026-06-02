/**
 * Aplica migraciones SQL pendientes al arrancar (idempotente).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSharedDbPool, hasDatabaseConfig } from "./picks-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

const MIGRATION_FILES = [
  "003_backtesting_clv.sql",
  "004_picks_history.sql",
  "005_analysis_cache.sql",
];

export async function runPendingMigrations() {
  if (!hasDatabaseConfig()) {
    return { ran: 0, storage: "none" };
  }

  const pool = getSharedDbPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  let ran = 0;
  for (const file of MIGRATION_FILES) {
    const { rows } = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1`, [file]);
    if (rows.length) continue;

    const sqlPath = path.join(ROOT, file);
    const sql = await readFile(sqlPath, "utf8");
    await pool.query(sql);
    await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    ran += 1;
    console.log(`[db] MigraciÃ³n aplicada: ${file}`);
  }

  return { ran, storage: "postgresql" };
}

