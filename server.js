import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "./src/config/load-env.js";
import { buildFootballAnalysis } from "./src/services/football-analyzer.js";
import { buildMlbAnalysis } from "./src/services/mlb-analyzer.js";
import { buildNbaAnalysis } from "./src/services/nba-analyzer.js";
import { buildWnbaAnalysis } from "./src/services/wnba-analyzer.js";
import { buildNflAnalysis } from "./src/services/nfl-analyzer.js";
import { buildQuinielaAnalysis, debugQuinielaCard } from "./src/services/quiniela-analyzer.js";
import {
  correctPickResult,
  dbHealthCheck,
  deletePendingPick,
  getPendingPickTimingMetaLive,
  getPendingToday,
  getPicks,
  getStats,
  savePick,
  updateBankroll,
  updatePickResult,
  waitForDatabase,
} from "./src/services/picks-db.js";
import { notifyAnalysisDetectedPick, notifyDailyBalanceTelegram, notifyNewPickTelegram, notifyQuinielaOfficialProposal, notifyQuinielaPlazoCerradaTelegram, notifyQuinielaResultadosTelegram, notifyResolvedPickTelegram } from "./src/services/telegram-notifier.js";
import { clearTelegramFlags, resendPendingTrackerPicks } from "./src/services/telegram-resend.js";
import { reconcilePendingTrackerPicks } from "./src/services/tracker-settlement.js";
import { getStats as getBacktestStats, getCLVReport, getCalibrationReport } from "./src/services/backtesting.js";
import { reconcileBacktestingResults } from "./src/services/backtesting-settlement.js";
import { runPendingMigrations } from "./src/services/db-migrations.js";
import { recordAnalysisSnapshots } from "./src/services/pick-backtest-service.js";
import {
  getAppTimezone,
  getDateStringInTimezone,
  getMadridTodayDateString,
  getMadridYesterdayDateString,
  resolveAnalysisDate,
  shiftDateString,
} from "./src/utils/madrid-date.js";
import { buildPickIdentityKey } from "./src/utils/pick-identity.js";
import {
  getCachedAnalysis,
  getCachedAnalysisIfAvailable,
  getAnalysisCacheTtlMs,
  invalidateAnalysisCache,
  peekCachedAnalysis,
} from "./src/services/analysis-response-cache.js";
import { isQuinielaPlazoCerrado } from "./src/services/quiniela-official-cache.js";
import {
  loadQuinielaAnalysisCached,
  peekQuinielaAnalysisCache,
  quinielaPayloadIsComplete,
} from "./src/services/quiniela-request-cache.js";
import {
  getPublicSplitsStatus,
  refreshPublicSplits,
  startPublicSplitsJob,
} from "./src/services/public-splits-store.js";
import { getOddsApiRateLimitState,
  loadFootballEvents,
  loadFootballValueBets,
  loadFootballDroppingOdds,
  loadBaseballEvents,
  loadBaseballValueBets,
  loadBaseballDroppingOdds,
  loadBasketballValueBets,
  loadBasketballDroppingOdds,
  loadAmericanFootballValueBets,
  loadAmericanFootballDroppingOdds,
} from "./src/providers/odds-api-io.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const PREWARM_INTERVAL_MS =
  Math.max(5, Number.parseInt(process.env.PREWARM_INTERVAL_MINUTES || "30", 10) || 30) * 60 * 1000;
const PREWARM_ODDS_ENDPOINTS = /^(1|true|yes|on)$/i.test(
  String(process.env.PREWARM_ODDS_ENDPOINTS || "").trim()
);
const BACKTEST_RECONCILE_MS = 30 * 60 * 1000;

function shouldSettleTrackerQuery(searchParams) {
  return searchParams.get("settle") !== "0";
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function resolveHomePickEstado(pick) {
  const estado = String(pick?.estado || pick?.estado_color || "").toLowerCase();
  if (estado === "verde" || estado === "amarillo") return estado;
  if (pick?.readyToBet || pick?.bettable) return "verde";
  if (pick?.safeForComboLeg) return "amarillo";
  return null;
}

function isHomeSectionPick(pick) {
  const estado = resolveHomePickEstado(pick);
  return estado === "verde" || estado === "amarillo";
}

function collectAnalysisNotificationPicks(analysis, sport) {
  const buckets = [
    ...(Array.isArray(analysis?.picks) ? analysis.picks : []),
    ...(Array.isArray(analysis?.top5_jornada) ? analysis.top5_jornada : []),
  ];
  const seen = new Set();
  const result = [];
  for (const pick of buckets) {
    if (!isHomeSectionPick(pick)) continue;
    const key = buildPickIdentityKey({ ...pick, sport });
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    result.push(pick);
  }
  return result;
}

async function queueAnalysisPickNotifications(sport, analysis) {
  if (!analysis?.dataAvailable) return;
  const picks = collectAnalysisNotificationPicks(analysis, sport);
  if (!picks.length) return;
  for (const pick of picks) {
    try {
      await notifyAnalysisDetectedPick(sport, pick);
    } catch (error) {
      console.error("[telegram] Error notificando pick detectado en analisis:", error.message);
    }
  }
}

async function loadAnalysisWithTelegram(cacheKey, builder, sport, { refresh = false } = {}) {
  if (refresh) {
    invalidateAnalysisCache(cacheKey);
  }

  const before = peekCachedAnalysis(cacheKey);

  let analysis;
  if (!refresh) {
    const cached = getCachedAnalysisIfAvailable(cacheKey);
    const activeRateLimit = getOddsApiRateLimitState();
    if (cached?.payload && (cached.isFresh || activeRateLimit)) {
      analysis = {
        ...cached.payload,
        cacheMeta: {
          servedFrom: cached.isFresh ? "fresh" : "stale",
          skippedBuild: true,
          storedAt: cached.storedAt || null,
        },
      };
    }
  }
  if (!analysis) {
    analysis = await getCachedAnalysis(cacheKey, builder, { ttlMs: getAnalysisCacheTtlMs() });
    const peek = peekCachedAnalysis(cacheKey);
    analysis = {
      ...analysis,
      cacheMeta: {
        servedFrom: refresh ? "refresh" : "built",
        skippedBuild: false,
        storedAt: peek?.storedAt || Date.now(),
      },
    };
  }

  const after = peekCachedAnalysis(cacheKey);
  const builtFresh = Boolean(after?.storedAt && after.storedAt !== before?.storedAt);
  if (builtFresh && !analysis?.cacheMeta?.skippedBuild) {
    queueAnalysisPickNotifications(sport, analysis);
    recordAnalysisSnapshots(sport, analysis, analysis?.date).catch((error) => {
      console.warn("[backtest] Snapshot error:", error.message);
    });
  }
  return analysis;
}

function wantsAnalysisRefresh(searchParams) {
  return searchParams.get("refresh") === "1" || searchParams.get("force") === "1";
}

async function serveStatic(res, pathname) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.join(publicDir, target);

  if (!resolved.startsWith(publicDir)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  try {
    const data = await readFile(resolved);
    const extension = path.extname(resolved);
    const noStoreExtensions = new Set([".html", ".css", ".js"]);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": noStoreExtensions.has(extension) ? "no-store" : "public, max-age=300",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("JSON invalido"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/api/health" && method === "GET") {
      sendJson(res, 200, {
        status: "ok",
        service: "sports-oracle",
        timestamp: new Date().toISOString(),
        timezone: getAppTimezone(),
        analysisDate: getMadridTodayDateString(),
      });
      return;
    }

    if (url.pathname === "/api/public-splits/status" && method === "GET") {
      if (url.searchParams.get("refresh") === "1") {
        await refreshPublicSplits({ reason: "api" });
      }
      sendJson(res, 200, getPublicSplitsStatus());
      return;
    }

    if (url.pathname === "/api/mlb/analyze" && method === "GET") {
      const date = resolveAnalysisDate(url.searchParams.get("date"));
      const refresh = wantsAnalysisRefresh(url.searchParams);
      const analysis = await loadAnalysisWithTelegram(`mlb:${date}`, () => buildMlbAnalysis(date), "mlb", { refresh });
      sendJson(res, 200, analysis);
      return;
    }

    if (url.pathname === "/api/futbol/analyze" && method === "GET") {
      const date = resolveAnalysisDate(url.searchParams.get("date"));
      const refresh = wantsAnalysisRefresh(url.searchParams);
      const analysis = await loadAnalysisWithTelegram(`futbol:${date}`, () => buildFootballAnalysis(date), "futbol", { refresh });
      sendJson(res, 200, analysis);
      return;
    }

    if (url.pathname === "/api/nba/analyze" && method === "GET") {
      const date = resolveAnalysisDate(url.searchParams.get("date"));
      const refresh = wantsAnalysisRefresh(url.searchParams);
      const analysis = await loadAnalysisWithTelegram(`nba:${date}`, () => buildNbaAnalysis(date), "nba", { refresh });
      sendJson(res, 200, analysis);
      return;
    }

    if (url.pathname === "/api/wnba/analyze" && method === "GET") {
      const date = resolveAnalysisDate(url.searchParams.get("date"));
      const refresh = wantsAnalysisRefresh(url.searchParams);
      const analysis = await loadAnalysisWithTelegram(`wnba:${date}`, () => buildWnbaAnalysis(date), "wnba", { refresh });
      sendJson(res, 200, analysis);
      return;
    }

    if (url.pathname === "/api/nfl/analyze" && method === "GET") {
      const date = resolveAnalysisDate(url.searchParams.get("date"));
      const refresh = wantsAnalysisRefresh(url.searchParams);
      const week = url.searchParams.get("week");
      const season = url.searchParams.get("season");
      const analysis = await loadAnalysisWithTelegram(
        `nfl:${date}:${week || ""}:${season || ""}`,
        () => buildNflAnalysis(date, week, season),
        "nfl",
        { refresh }
      );
      sendJson(res, 200, analysis);
      return;
    }

    if (url.pathname === "/api/quiniela/analyze" && method === "GET") {
      const date = resolveAnalysisDate(url.searchParams.get("date"));
      const refresh = wantsAnalysisRefresh(url.searchParams);
      const analysis = await loadQuinielaAnalysisCached(date, () => buildQuinielaAnalysis(date), { refresh });
      sendJson(res, 200, analysis);
      return;
    }

    if (url.pathname === "/api/quiniela/debug" && method === "GET") {
      sendJson(res, 200, await debugQuinielaCard());
      return;
    }

    if (url.pathname === "/api/telegram/reset-flags" && method === "POST") {
      try {
        const verdeOnly = url.searchParams.get("verdeOnly") === "1";
        const resend = url.searchParams.get("resend") !== "0";
        const trigger = url.searchParams.get("trigger") === "1";
        const deleted = await clearTelegramFlags({ verdeOnly });
        const resent = resend ? await resendPendingTrackerPicks({ verdeOnly }) : { total: 0, sent: 0 };
        if (trigger) {
          const date = getMadridTodayDateString();
          loadAnalysisWithTelegram(`mlb:${date}`, () => buildMlbAnalysis(date), "mlb").catch(() => {});
          loadAnalysisWithTelegram(`futbol:${date}`, () => buildFootballAnalysis(date), "futbol").catch(() => {});
          loadAnalysisWithTelegram(`nba:${date}`, () => buildNbaAnalysis(date), "nba").catch(() => {});
          loadAnalysisWithTelegram(`wnba:${date}`, () => buildWnbaAnalysis(date), "wnba").catch(() => {});
          loadAnalysisWithTelegram(`nfl:${date}`, () => buildNflAnalysis(date), "nfl").catch(() => {});
        }
        sendJson(res, 200, { ok: true, deleted, resent, trigger });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/db/health" && method === "GET") {
      const health = await dbHealthCheck();
      sendJson(res, health.ok ? 200 : 503, health);
      return;
    }

    if (url.pathname === "/api/stats" && method === "GET") {
      try {
        if (shouldSettleTrackerQuery(url.searchParams)) {
          await reconcilePendingTrackerPicks();
        }
        sendJson(res, 200, await getStats());
      } catch (error) {
        sendJson(res, 503, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/backtest/stats" && method === "GET") {
      try {
        const filters = {
          sport: url.searchParams.get("sport") || undefined,
          league: url.searchParams.get("league") || undefined,
          market: url.searchParams.get("market") || undefined,
          color: url.searchParams.get("color") || undefined,
          dateFrom: url.searchParams.get("dateFrom") || undefined,
          dateTo: url.searchParams.get("dateTo") || undefined,
          minConfidence: url.searchParams.get("minConfidence") || undefined,
        };
        if (shouldSettleTrackerQuery(url.searchParams)) {
          await reconcileBacktestingResults().catch(() => {});
        }
        sendJson(res, 200, await getBacktestStats(filters));
      } catch (error) {
        sendJson(res, 503, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/backtest/clv" && method === "GET") {
      try {
        const filters = {
          sport: url.searchParams.get("sport") || undefined,
          market: url.searchParams.get("market") || undefined,
        };
        sendJson(res, 200, await getCLVReport(filters));
      } catch (error) {
        sendJson(res, 503, { error: error.message });
      }
      return;
    }

    if (
      (url.pathname === "/api/backtesting/calibration" ||
        url.pathname === "/api/backtest/calibration") &&
      method === "GET"
    ) {
      try {
        const filters = {
          sport: url.searchParams.get("sport") || undefined,
          market: url.searchParams.get("market") || undefined,
          color: url.searchParams.get("color") || undefined,
          dateFrom: url.searchParams.get("dateFrom") || undefined,
          dateTo: url.searchParams.get("dateTo") || undefined,
        };
        sendJson(res, 200, await getCalibrationReport(filters));
      } catch (error) {
        sendJson(res, 503, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/backtest/reconcile" && method === "POST") {
      try {
        const body = method === "POST" ? await readBody(req).catch(() => ({})) : {};
        sendJson(res, 200, await reconcileBacktestingResults({ date: body?.date }));
      } catch (error) {
        sendJson(res, 503, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/picks" && method === "GET") {
      try {
        const picks = await getPicks({
          date: url.searchParams.get("date") || undefined,
          sport: url.searchParams.get("sport") || undefined,
          resultado: url.searchParams.get("resultado") || undefined,
          limit: Number(url.searchParams.get("limit") || 100),
        });
        sendJson(res, 200, { picks });
      } catch (error) {
        sendJson(res, 503, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/picks/pending" && method === "GET") {
      try {
        if (shouldSettleTrackerQuery(url.searchParams)) {
          await reconcilePendingTrackerPicks();
        }
        const dateParam = url.searchParams.get("date");
        const date = dateParam ? resolveAnalysisDate(dateParam) : null;
        const picks = (await getPendingToday(date)).map((pick) => ({
          ...pick,
          ...getPendingPickTimingMetaLive(pick),
        }));
        sendJson(res, 200, { date, picks });
      } catch (error) {
        sendJson(res, 503, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/picks" && method === "POST") {
      try {
        const body = await readBody(req);
        const result = await savePick(body);
        if (result?.pick && (result.created || result.tierUpgraded || result.tierDowngraded)) {
          notifyNewPickTelegram(result.pick, {
            tierChange: result.tierChange || null,
            previousPick: result.previousPick || null,
          }).catch((error) => {
            console.error("[telegram] Error notificando pick nuevo:", error.message);
          });
        }
        sendJson(res, result.created ? 201 : 200, result);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    const updateMatch = url.pathname.match(/^\/api\/picks\/(\d+)\/resultado$/);
    if (updateMatch && method === "PATCH") {
      try {
        const body = await readBody(req);
        const pick = await updatePickResult(Number(updateMatch[1]), body.resultado, body.cuota_real);
        if (pick) {
          notifyResolvedPickTelegram(pick).catch((error) => {
            console.error("[telegram] Error notificando pick resuelto:", error.message);
          });
        }
        sendJson(res, 200, { pick });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    const correctMatch = url.pathname.match(/^\/api\/picks\/(\d+)\/corregir$/);
    if (correctMatch && method === "PATCH") {
      try {
        const body = await readBody(req);
        const pick = await correctPickResult(Number(correctMatch[1]), body.resultado, body.cuota_real);
        if (pick) {
          notifyResolvedPickTelegram(pick).catch((error) => {
            console.error("[telegram] Error notificando correccion:", error.message);
          });
        }
        sendJson(res, 200, { pick });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    const deleteMatch = url.pathname.match(/^\/api\/picks\/(\d+)$/);
    if (deleteMatch && method === "DELETE") {
      try {
        const deleted = await deletePendingPick(Number(deleteMatch[1]));
        if (!deleted) {
          sendJson(res, 404, { error: "Pick no encontrado o ya resuelto" });
          return;
        }
        sendJson(res, 200, { deleted: true });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (url.pathname === "/api/bankroll" && method === "PUT") {
      try {
        const body = await readBody(req);
        const bankroll = await updateBankroll(body);
        sendJson(res, 200, { bankroll });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "internal_error" });
  }
});

function getMadridHour() {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", hour: "numeric", hour12: false })
      .format(new Date())
  );
}

async function prewarmOddsCache() {
  const hour = getMadridHour();
  if (hour >= 0 && hour < 7) {
    return;
  }
  if (getOddsApiRateLimitState()) {
    console.log("[prewarm] Saltando — rate limit activo en Odds-API.io.");
    return;
  }
  // Endpoints ligeros opcionales; el análisis ya calienta cuotas y señales cuando hace falta.
  if (PREWARM_ODDS_ENDPOINTS) {
    await Promise.allSettled([
      loadFootballEvents(),
      loadBaseballEvents(),
      loadFootballValueBets("Bet365"),
      loadFootballValueBets("Winamax FR"),
      loadBaseballValueBets("Bet365"),
      loadBaseballValueBets("Winamax FR"),
      loadFootballDroppingOdds(),
      loadBaseballDroppingOdds(),
      loadBasketballValueBets("Bet365"),
      loadBasketballValueBets("Winamax FR"),
      loadAmericanFootballValueBets("Bet365"),
      loadAmericanFootballValueBets("Winamax FR"),
      loadBasketballDroppingOdds(),
      loadAmericanFootballDroppingOdds(),
    ]);
    console.log("[prewarm] Endpoints base de Odds-API.io actualizados (14 llamadas máx.).");
  }

  await prewarmAnalysisCaches();
}

async function prewarmAnalysisCaches() {
  const prewarmDate = getMadridTodayDateString();
  const prewarmConcurrency = Math.max(1, Number(process.env.PREWARM_CONCURRENCY || 2));

  const modules = [
    { key: `mlb:${prewarmDate}`, build: () => buildMlbAnalysis(prewarmDate), label: "MLB", sport: "mlb" },
    { key: `futbol:${prewarmDate}`, build: () => buildFootballAnalysis(prewarmDate), label: "Fútbol", sport: "futbol" },
    { key: `nba:${prewarmDate}`, build: () => buildNbaAnalysis(prewarmDate), label: "NBA", sport: "nba" },
    { key: `wnba:${prewarmDate}`, build: () => buildWnbaAnalysis(prewarmDate), label: "WNBA", sport: "wnba" },
    { key: `nfl:${prewarmDate}`, build: () => buildNflAnalysis(prewarmDate), label: "NFL", sport: "nfl" },
  ];

  const queue = modules.filter((entry) => {
    const cached = getCachedAnalysisIfAvailable(entry.key, { enrichRateLimit: false });
    return !cached?.isFresh;
  });

  async function prewarmEntry(entry) {
    try {
      await loadAnalysisWithTelegram(entry.key, entry.build, entry.sport, { refresh: false });
      console.log(`[prewarm] Análisis ${entry.label} en caché (+ notificaciones si hay picks nuevos).`);
    } catch (err) {
      console.warn(`[prewarm] ${entry.label} falló:`, err?.message);
    }
  }

  const workers = Array.from({ length: Math.min(prewarmConcurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (entry) await prewarmEntry(entry);
    }
  });
  await Promise.all(workers);

  const quinielaKey = `quiniela:${prewarmDate}`;
  const quinielaCached = getCachedAnalysisIfAvailable(quinielaKey, {
    enrichRateLimit: false,
    isUsable: quinielaPayloadIsComplete,
  });
  if (!quinielaCached?.isFresh) {
    try {
      await loadQuinielaAnalysisCached(prewarmDate, () => buildQuinielaAnalysis(prewarmDate), { refresh: false });
      console.log("[prewarm] Análisis Quiniela en caché.");
    } catch (err) {
      console.warn("[prewarm] Quiniela falló:", err?.message);
    }
  }
}

const SETTLEMENT_INTERVAL_MS = 5 * 60 * 1000;
const QUINIELA_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const QUINIELA_RESULTS_INTERVAL_MS = 15 * 60 * 1000;

let quinielaSchedulerRunning = false;

function getMadridDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: getAppTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return map;
}

function resolveUtcForMadridLocal(dateKey, hour, minute) {
  const tz = getAppTimezone();
  const anchor = new Date(`${dateKey}T12:00:00Z`).getTime();
  for (let offsetMs = -14 * 3600000; offsetMs <= 14 * 3600000; offsetMs += 60_000) {
    const candidate = new Date(anchor + offsetMs);
    if (getDateStringInTimezone(candidate, tz) !== dateKey) continue;
    const parts = getMadridDateTimeParts(candidate);
    if (parts.hour === hour && parts.minute === minute) {
      return candidate;
    }
  }
  return null;
}

async function sendDailySummaryTelegram() {
  const yesterday = getMadridYesterdayDateString();
  await reconcilePendingTrackerPicks({ force: true }).catch((error) => {
    console.warn("[telegram-scheduler] Settlement previo al resumen diario:", error.message);
  });
  const picks = await getPicks({ date: yesterday, limit: 5000 });
  const ganados = picks.filter((pick) => String(pick?.resultado || "").toLowerCase() === "ganado").length;
  const perdidos = picks.filter((pick) => String(pick?.resultado || "").toLowerCase() === "perdido").length;
  const voids = picks.filter((pick) => String(pick?.resultado || "").toLowerCase() === "void").length;
  const pendientes = picks.filter((pick) => String(pick?.resultado || "").toLowerCase() === "pendiente").length;
  const totalResueltos = ganados + perdidos + voids;

  if (totalResueltos === 0 && pendientes === 0) {
    console.log(`[telegram-scheduler] Sin picks para ${yesterday} — no se manda resumen`);
    return;
  }

  let gananciaTotalU = 0;
  for (const pick of picks.filter((pick) => String(pick?.resultado || "").toLowerCase() !== "pendiente")) {
    const cuota = Number(pick.cuota_real || pick.cuota || 1);
    const resultado = String(pick?.resultado || "").toLowerCase();
    if (resultado === "ganado") gananciaTotalU += cuota - 1;
    else if (resultado === "perdido") gananciaTotalU -= 1;
  }

  const roiPct = totalResueltos > 0 ? (gananciaTotalU / totalResueltos) * 100 : null;

  await notifyDailyBalanceTelegram({
    date: yesterday,
    ganados,
    perdidos,
    voids,
    totalResueltos,
    pendientes,
    gananciaTotalU: Number(gananciaTotalU.toFixed(2)),
    roiPct: roiPct != null ? Number(roiPct.toFixed(1)) : null,
  });
}

function scheduleDailySummary() {
  const now = new Date();
  const madrid = getMadridDateTimeParts(now);
  const todayKey = getMadridTodayDateString(now);
  const passed005 =
    madrid.hour > 0 || (madrid.hour === 0 && madrid.minute >= 5);
  const targetDateKey = passed005 ? shiftDateString(todayKey, 1) : todayKey;
  const targetUtc = resolveUtcForMadridLocal(targetDateKey, 0, 5);
  const msUntilTarget = targetUtc
    ? Math.max(1000, targetUtc.getTime() - now.getTime())
    : 24 * 60 * 60 * 1000;

  console.log(
    `[telegram-scheduler] Próximo resumen diario en ${Math.round(msUntilTarget / 60000)} min (${targetDateKey} 00:05 Madrid)`
  );

  setTimeout(async () => {
    try {
      await sendDailySummaryTelegram();
    } catch (error) {
      console.error("[telegram-scheduler] Error en resumen diario:", error.message);
    }
    scheduleDailySummary();
  }, msUntilTarget);
}

async function runAutoSettlement() {
  try {
    await reconcilePendingTrackerPicks();
  } catch (error) {
    console.warn("[settlement] Error en auto-settlement:", error.message);
  }
}

function buildQuinielaPronosticoFingerprint(analysis) {
  const rows = analysis?.propuestaOficial || analysis?.propuesta || [];
  if (!rows.length) return "";
  return rows
    .slice(0, 14)
    .map((row) => `${row.order}:${row.pick}:${row.tipo}`)
    .join("|");
}

async function runQuinielaResultadosUpdate(date) {
  try {
    const { fetchQuinielaResultados, evaluateQuinielaPronostico } = await import(
      "./src/services/quiniela-results-updater.js"
    );

    const cached = peekQuinielaAnalysisCache(date);
    const analysis = cached?.payload;
    const jornada = analysis?.officialSource?.jornadaAnalizada;

    if (!jornada) {
      console.log("[quiniela-results] Sin jornada activa para resultados");
      return;
    }

    const resultados = await fetchQuinielaResultados(jornada);
    if (!resultados?.length) {
      console.log("[quiniela-results] Sin resultados disponibles aún");
      return;
    }

    const propuesta = analysis?.propuestaOficial || [];
    const evaluacion = evaluateQuinielaPronostico(propuesta, resultados);
    if (!evaluacion) return;

    if (evaluacion.pendientes === 0) {
      console.log(
        `[quiniela-results] Jornada ${jornada} completa: ${evaluacion.aciertos}/14 aciertos`
      );
      await notifyQuinielaResultadosTelegram({ jornada, evaluacion });
    } else {
      console.log(`[quiniela-results] ${evaluacion.pendientes} partidos pendientes aún`);
    }
  } catch (error) {
    console.error("[quiniela-results] Error:", error.message);
  }
}

async function runQuinielaResultadosUpdateLocked(date) {
  try {
    const { fetchQuinielaResultados, evaluateQuinielaPronostico, mergeQuinielaResultados } =
      await import("./src/services/quiniela-results-updater.js");
    const {
      getStoredQuinielaForecast,
      quinielaResultsAreComplete,
      saveQuinielaForecastSnapshot,
    } = await import("./src/services/quiniela-state-store.js");

    const cached = peekQuinielaAnalysisCache(date);
    const stored = await getStoredQuinielaForecast().catch(() => null);
    const analysis = cached?.payload || stored;
    const jornada = analysis?.officialSource?.jornadaAnalizada;

    if (!jornada) {
      console.log("[quiniela-results] Sin jornada activa para resultados");
      return;
    }

    const storedSameJornada =
      Number(stored?.officialSource?.jornadaAnalizada) === Number(jornada) ? stored : null;
    if (quinielaResultsAreComplete(storedSameJornada || analysis)) {
      console.log(`[quiniela-results] Jornada ${jornada} ya esta completa; polling omitido`);
      return;
    }

    if (!isQuinielaPlazoCerrado(analysis?.officialSource)) {
      console.log("[quiniela-results] Jornada abierta; polling de resultados omitido");
      return;
    }

    const resultados = await fetchQuinielaResultados(jornada);
    if (!resultados?.length) {
      console.log("[quiniela-results] Sin resultados disponibles aun");
      return;
    }

    const updatedAnalysis = mergeQuinielaResultados(analysis, resultados, { source: "official" });
    await saveQuinielaForecastSnapshot(updatedAnalysis, { reason: "results-update" });

    const evaluacion =
      updatedAnalysis?.evaluacionResultados ||
      evaluateQuinielaPronostico(updatedAnalysis?.propuestaOficial || [], resultados);
    if (!evaluacion) return;

    if (evaluacion.pendientes === 0) {
      console.log(`[quiniela-results] Jornada ${jornada} completa: ${evaluacion.aciertos}/14 aciertos`);
      await notifyQuinielaResultadosTelegram({ jornada, evaluacion });
    } else {
      console.log(`[quiniela-results] ${evaluacion.pendientes} partidos pendientes aun`);
    }
  } catch (error) {
    console.error("[quiniela-results] Error:", error.message);
  }
}

async function runQuinielaScheduledUpdate() {
  if (quinielaSchedulerRunning) return;
  quinielaSchedulerRunning = true;

  try {
    const date = getMadridTodayDateString();
    const cached = peekQuinielaAnalysisCache(date);
    const previousAnalysis = cached?.payload;
    const plazoCerrado = isQuinielaPlazoCerrado(previousAnalysis?.officialSource);

    if (plazoCerrado) {
      console.log("[quiniela-scheduler] Plazo cerrado — actualizando solo resultados");
      await notifyQuinielaPlazoCerradaTelegram({
        jornada: previousAnalysis?.officialSource?.jornadaAnalizada,
        closingTime: previousAnalysis?.officialSource?.closingTime,
        propuesta: previousAnalysis?.propuestaOficial || [],
      });
      await runQuinielaResultadosUpdateLocked(date);
      return;
    }

    if (!quinielaPayloadIsComplete(previousAnalysis)) {
      console.log("[quiniela-scheduler] Sin jornada activa; intentando detectar publicacion");
      const analysis = await loadQuinielaAnalysisCached(
        date,
        () => buildQuinielaAnalysis(date),
        { refresh: true }
      );
      if (!quinielaPayloadIsComplete(analysis)) {
        console.log("[quiniela-scheduler] Sin composicion oficial publicada");
        return;
      }
      if (isQuinielaPlazoCerrado(analysis?.officialSource)) {
        await notifyQuinielaPlazoCerradaTelegram({
          jornada: analysis?.officialSource?.jornadaAnalizada,
          closingTime: analysis?.officialSource?.closingTime,
          propuesta: analysis?.propuestaOficial || [],
        });
        await runQuinielaResultadosUpdateLocked(date);
        return;
      }
      if (analysis?.telegramPayload) {
        await notifyQuinielaOfficialProposal({
          ...analysis.telegramPayload,
          isUpdate: false,
        });
      }
      return;
    }

    console.log("[quiniela-scheduler] Actualizando pronostico quiniela...");
    const previousFingerprint = buildQuinielaPronosticoFingerprint(previousAnalysis);

    const analysis = await loadQuinielaAnalysisCached(
      date,
      () => buildQuinielaAnalysis(date),
      { refresh: true }
    );

    if (isQuinielaPlazoCerrado(analysis?.officialSource)) {
      console.log("[quiniela-scheduler] Plazo cerrado tras refresh — congelando pronóstico");
      await notifyQuinielaPlazoCerradaTelegram({
        jornada: analysis?.officialSource?.jornadaAnalizada,
        closingTime: analysis?.officialSource?.closingTime,
        propuesta: analysis?.propuestaOficial || [],
      });
      await runQuinielaResultadosUpdateLocked(date);
      return;
    }

    const newFingerprint = buildQuinielaPronosticoFingerprint(analysis);
    if (newFingerprint !== previousFingerprint && analysis?.telegramPayload) {
      console.log("[quiniela-scheduler] Pronóstico cambió — notificando Telegram");
      await notifyQuinielaOfficialProposal({
        ...analysis.telegramPayload,
        isUpdate: true,
      });
    } else {
      console.log("[quiniela-scheduler] Sin cambios en el pronóstico");
    }
  } catch (error) {
    console.error("[quiniela-scheduler] Error en actualización:", error.message);
  } finally {
    quinielaSchedulerRunning = false;
  }
}

server.listen(port, () => {
  console.log(`Tennis Oracle disponible en http://localhost:${port}`);
  waitForDatabase()
    .then((health) => {
      if (!health.ok) {
        console.warn("[db] PostgreSQL no disponible:", health.error || "sin detalle");
        return null;
      }
      console.log("[db] PostgreSQL conectado.");
      return runPendingMigrations();
    })
    .then((result) => {
      if (result?.ran) console.log(`[db] ${result.ran} migración(es) aplicada(s).`);
    })
    .catch((error) => console.warn("[db] Migraciones:", error.message));
  setTimeout(() => prewarmOddsCache(), 5_000);
  setInterval(prewarmOddsCache, PREWARM_INTERVAL_MS);
  startPublicSplitsJob();
  scheduleDailySummary();
  setTimeout(() => runAutoSettlement(), 10_000);
  setInterval(() => runAutoSettlement(), SETTLEMENT_INTERVAL_MS);
  setTimeout(() => runQuinielaScheduledUpdate(), 15_000);
  setInterval(() => runQuinielaScheduledUpdate(), QUINIELA_UPDATE_INTERVAL_MS);
  setTimeout(() => runQuinielaResultadosUpdateLocked(getMadridTodayDateString()), 45_000);
  setInterval(() => runQuinielaResultadosUpdateLocked(getMadridTodayDateString()), QUINIELA_RESULTS_INTERVAL_MS);
  setInterval(() => {
    reconcileBacktestingResults().catch((error) => {
      console.warn("[backtest] reconcile:", error.message);
    });
  }, BACKTEST_RECONCILE_MS);
});
