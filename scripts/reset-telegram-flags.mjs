#!/usr/bin/env node
/**
 * Limpia flags de Telegram y reenvía picks pendientes del tracker.
 * Uso: node scripts/reset-telegram-flags.mjs [--verde-only] [--trigger] [--no-resend]
 */
import "../src/config/load-env.js";
import fs from "node:fs";
import path from "node:path";
import { clearTelegramFlags, resendPendingTrackerPicks } from "../src/services/telegram-resend.js";

const args = new Set(process.argv.slice(2));
const verdeOnly = args.has("--verde-only");
const trigger = args.has("--trigger");
const resend = !args.has("--no-resend");

function clearLocalStateFiles() {
  const root = process.cwd();
  const files = [".telegram-daily-balance-sent.json", ".quiniela-jornadas-sent.json"];
  for (const name of files) {
    const target = path.join(root, name);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        console.log(`Eliminado: ${name}`);
      }
    } catch (error) {
      console.warn(`No se pudo borrar ${name}:`, error.message);
    }
  }
}

async function triggerAnalysis() {
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const paths = [
    "/api/mlb/analyze",
    "/api/futbol/analyze",
    "/api/nba/analyze",
    "/api/wnba/analyze",
    "/api/nfl/analyze",
    "/api/quiniela/analyze",
  ];
  for (const pathname of paths) {
    try {
      const response = await fetch(`${base}${pathname}`);
      console.log(`${pathname} -> ${response.status}`);
    } catch (error) {
      console.warn(`${pathname} falló:`, error.message);
    }
  }
}

async function main() {
  const deleted = await clearTelegramFlags({ verdeOnly });
  console.log(`pick_telegram_sent: eliminados ${deleted}`);
  clearLocalStateFiles();

  if (resend) {
    const result = await resendPendingTrackerPicks({ verdeOnly });
    console.log(`Tracker reenviado: ${result.sent}/${result.total}`);
  }

  if (trigger) {
    console.log("Disparando análisis para picks de home...");
    await triggerAnalysis();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
