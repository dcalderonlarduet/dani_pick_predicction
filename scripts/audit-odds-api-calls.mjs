#!/usr/bin/env node
/**
 * Estima y (opcionalmente) mide llamadas reales a Odds-API.io por ciclo de análisis.
 *
 * Uso:
 *   node scripts/audit-odds-api-calls.mjs           # solo estimación teórica
 *   node scripts/audit-odds-api-calls.mjs --live    # rebuild MLB con contador real
 */
import "../src/config/load-env.js";
import {
  getOddsApiMultiChunkSize,
  getOddsApiRequestStats,
  resetOddsApiRequestStats,
  oddsApiSkipMarketSignals,
} from "../src/providers/odds-api-io.js";
import { buildMlbAnalysis } from "../src/services/mlb-analyzer.js";
import { getMadridTodayDateString } from "../src/utils/madrid-date.js";

const chunkSize = getOddsApiMultiChunkSize();
const skipSignals = oddsApiSkipMarketSignals();

function ceilChunks(events) {
  return Math.ceil(Math.max(0, events) / chunkSize);
}

function estimateModule({ label, eventsPerDay, days = 3, signals = 3, sharedEvents = false }) {
  const uniqueEvents = sharedEvents ? eventsPerDay * days * 0.85 : eventsPerDay * days;
  const eventsCalls = sharedEvents ? 1 : days;
  const multiCalls = ceilChunks(uniqueEvents);
  const signalCalls = skipSignals ? 0 : signals;
  const total = eventsCalls + multiCalls + signalCalls;
  return { label, eventsCalls, multiCalls, signalCalls, total };
}

const estimates = [
  estimateModule({ label: "MLB", eventsPerDay: 15, signals: 3, sharedEvents: true }),
  estimateModule({ label: "NBA", eventsPerDay: 8, signals: 3, sharedEvents: true }),
  estimateModule({ label: "WNBA", eventsPerDay: 4, signals: 2, sharedEvents: true }),
  estimateModule({ label: "NFL", eventsPerDay: 6, signals: 3, sharedEvents: true }),
  estimateModule({ label: "Fútbol", eventsPerDay: 12, days: 1, signals: 3, sharedEvents: false }),
];

const prewarmEndpoints = /^(1|true|yes|on)$/i.test(String(process.env.PREWARM_ODDS_ENDPOINTS || "").trim())
  ? 14
  : 0;
const prewarmIntervalMin = Number.parseInt(process.env.PREWARM_INTERVAL_MINUTES || "30", 10) || 30;
const analysisTtlMin = 10;

console.log("=== Auditoría Odds-API.io ===\n");
console.log(`Chunk /odds/multi: ${chunkSize} eventos`);
console.log(`Señales (value-bets + dropping): ${skipSignals ? "DESACTIVADAS (ODDS_API_SKIP_SIGNALS=1)" : "activas"}`);
console.log(`Prewarm endpoints extra: ${prewarmEndpoints} (PREWARM_ODDS_ENDPOINTS)`);
console.log(`Intervalo prewarm: ${prewarmIntervalMin} min | TTL análisis: ~${analysisTtlMin} min\n`);

console.log("Estimación por módulo (caché fría, ventana ayer/hoy/mañana unificada):");
let coldTotal = 0;
for (const row of estimates) {
  coldTotal += row.total;
  console.log(
    `  ${row.label.padEnd(8)} → ${row.total} req  (/events: ${row.eventsCalls}, /odds/multi: ${row.multiCalls}, señales: ${row.signalCalls})`
  );
}

const fullRefreshCold = coldTotal;
const prewarmCold = prewarmEndpoints + fullRefreshCold;
const cyclesPerHour = 60 / prewarmIntervalMin;
const hourlyIfAllStale = Math.round(prewarmCold * cyclesPerHour);

console.log(`\nTotal refresh completo (5 deportes): ~${fullRefreshCold} req`);
console.log(`Ciclo prewarm (caché fría): ~${prewarmCold} req`);
console.log(`Si TODO expira cada ${prewarmIntervalMin} min: ~${hourlyIfAllStale} req/h (límite típico: 100/h)`);
console.log("\nCon caché caliente (TTL 10–30 min), la mayoría de ciclos usan 0 req de red.");

const live = process.argv.includes("--live");
if (!live) {
  console.log("\nEjecuta con --live para medir un buildMlbAnalysis real (requiere ODDS_API_IO_KEY).");
  process.exit(0);
}

if (!process.env.ODDS_API_IO_KEY) {
  console.error("\n--live requiere ODDS_API_IO_KEY en el entorno.");
  process.exit(1);
}

const date = getMadridTodayDateString();
resetOddsApiRequestStats();
console.log(`\nMidiendo buildMlbAnalysis(${date})...`);
await buildMlbAnalysis(date);
const stats = getOddsApiRequestStats();
console.log("\nLlamadas de red reales (MLB):", stats.total);
console.log("Por endpoint:", stats.byPath);
