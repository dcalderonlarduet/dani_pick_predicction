import { loadWithCache } from "../providers/shared/resource-cache.js";
import {
  getCachedAnalysis,
  getCachedAnalysisIfAvailable,
  invalidateAnalysisCache,
  peekCachedAnalysis,
} from "./analysis-response-cache.js";
import { buildFootballAnalysis } from "./football-analyzer.js";
import { fetchEspnInsightsForSpanishRows } from "../providers/espn-soccer.js";
import { extractClosingTimeFromCard, isQuinielaPlazoCerrado } from "./quiniela-official-cache.js";
import {
  getStoredQuinielaForecast,
  quinielaResultsAreComplete,
  saveQuinielaForecastSnapshot,
} from "./quiniela-state-store.js";

const ESPN_INSIGHTS_NAMESPACE = "quiniela-espn-insights";
const ESPN_INSIGHTS_TTL_MS = 45 * 60 * 1000;
const ESPN_INSIGHTS_STALE_MS = 3 * 60 * 60 * 1000;
const QUINIELA_OPEN_TTL_MS = 115 * 60 * 1000;
const QUINIELA_CLOSED_TTL_MS = 4 * 60 * 60 * 1000;

export function footballPayloadUsableForQuiniela(payload) {
  return Boolean(
    payload &&
      payload.dataAvailable !== false &&
      Array.isArray(payload.partidos) &&
      payload.partidos.length > 0
  );
}

export function quinielaPayloadIsComplete(payload) {
  if (!payload || payload.dataAvailable === false) return false;
  return (
    (Array.isArray(payload.propuestaOficial) && payload.propuestaOficial.length >= 14) ||
    (Array.isArray(payload.partidos) && payload.partidos.length >= 14)
  );
}

function isQuinielaPlazoCerradoPayload(payload) {
  if (!payload) return false;
  if (payload.officialSource?.plazoCerrado === true) return true;
  return isQuinielaPlazoCerrado(payload.officialSource || payload);
}

function isQuinielaPlazoCerradoFromPeek(peek) {
  return isQuinielaPlazoCerradoPayload(peek?.payload);
}

async function overlayQuinielaResultsIfClosed(payload, { force = false } = {}) {
  if (!payload || !isQuinielaPlazoCerradoPayload(payload)) return payload;
  try {
    const { refreshQuinielaResultadosForAnalysis } = await import("./quiniela-results-updater.js");
    return await refreshQuinielaResultadosForAnalysis(payload, { force });
  } catch (error) {
    console.warn("[quiniela-cache] No se pudieron superponer resultados:", error.message);
    return payload;
  }
}

async function finalizeQuinielaPayload(payload, meta = {}, { persistReason = "analysis" } = {}) {
  const withResults = await overlayQuinielaResultsIfClosed(payload, {
    force: meta.forceResults === true,
  });
  const plazoCerrado = isQuinielaPlazoCerradoPayload(withResults);
  const normalized = withResults?.officialSource
    ? {
        ...withResults,
        officialSource: {
          ...withResults.officialSource,
          plazoCerrado,
        },
      }
    : withResults;

  if (quinielaPayloadIsComplete(normalized)) {
    await saveQuinielaForecastSnapshot(normalized, { reason: persistReason }).catch((error) => {
      console.warn("[quiniela-cache] No se pudo persistir snapshot:", error.message);
    });
  }

  return {
    ...normalized,
    cacheMeta: {
      ...meta,
      plazoCerrado,
      closingTime: extractClosingTimeFromCard(normalized?.officialSource || normalized),
    },
  };
}

export function buildEspnInsightsCacheKey(jornada, rows = []) {
  const j = Number(jornada) || "na";
  const body = rows
    .map((row) => `${row.order}:${row.home}|${row.away}`)
    .sort()
    .join(";");
  return `j${j}:${body || "empty"}`;
}

export async function loadFootballForQuiniela(date) {
  const cacheKey = `futbol:${date}`;
  const cached = getCachedAnalysisIfAvailable(cacheKey, { enrichRateLimit: false });
  if (cached?.payload && footballPayloadUsableForQuiniela(cached.payload)) {
    return {
      data: cached.payload,
      layer: cached.isFresh ? "fresh" : "stale",
      skippedRemoteBuild: true,
    };
  }

  const data = await getCachedAnalysis(cacheKey, () => buildFootballAnalysis(date), {
    ttlMs: QUINIELA_OPEN_TTL_MS,
    enrichRateLimit: false,
  });
  return { data, layer: "built", skippedRemoteBuild: false };
}

export async function loadEspnInsightsForQuiniela({ jornada, unmatchedRows = [], date }) {
  if (!unmatchedRows.length) {
    return { data: {}, layer: "empty", skippedRemoteBuild: true };
  }

  const cacheKey = buildEspnInsightsCacheKey(jornada, unmatchedRows);
  const data = await loadWithCache(
    ESPN_INSIGHTS_NAMESPACE,
    cacheKey,
    {
      ttlMs: ESPN_INSIGHTS_TTL_MS,
      staleMs: ESPN_INSIGHTS_STALE_MS,
    },
    () =>
      fetchEspnInsightsForSpanishRows(
        unmatchedRows.map((row) => ({ order: row.order, home: row.home, away: row.away })),
        date
      )
  );

  return { data: data || {}, layer: "cache-or-built", skippedRemoteBuild: false };
}

export function peekQuinielaAnalysisCache(date) {
  return peekCachedAnalysis(`quiniela:${date}`);
}

export async function loadQuinielaAnalysisCached(date, builder, { refresh = false } = {}) {
  const cacheKey = `quiniela:${date}`;
  const peek = peekCachedAnalysis(cacheKey);
  const plazoCerrado = isQuinielaPlazoCerradoFromPeek(peek);
  const ttlMs = plazoCerrado ? QUINIELA_CLOSED_TTL_MS : QUINIELA_OPEN_TTL_MS;
  const storedForecast = await getStoredQuinielaForecast().catch(() => null);
  const storedLocked =
    isQuinielaPlazoCerradoPayload(storedForecast) && !quinielaResultsAreComplete(storedForecast);

  if ((plazoCerrado || storedLocked) && refresh) {
    console.log("[quiniela-cache] Plazo cerrado - refresh bloqueado para pronostico");
    refresh = false;
  }

  if (refresh) {
    invalidateAnalysisCache(cacheKey);
  }

  if (!refresh) {
    const cached = getCachedAnalysisIfAvailable(cacheKey, {
      enrichRateLimit: true,
      isUsable: quinielaPayloadIsComplete,
    });
    if (cached?.payload && quinielaPayloadIsComplete(cached.payload)) {
      return finalizeQuinielaPayload(
        cached.payload,
        {
          servedFrom: cached.isFresh ? "fresh" : "stale",
          skippedBuild: true,
          storedAt: cached.storedAt || null,
          expiresAt: cached.expiresAt || null,
        },
        { persistReason: "memory-cache" }
      );
    }

    if (storedLocked && quinielaPayloadIsComplete(storedForecast)) {
      return finalizeQuinielaPayload(
        storedForecast,
        {
          servedFrom: "locked-disk",
          skippedBuild: true,
          storedAt: null,
          expiresAt: null,
        },
        { persistReason: "locked-disk" }
      );
    }
  }

  try {
    const built = await getCachedAnalysis(cacheKey, builder, {
      ttlMs,
      isUsable: quinielaPayloadIsComplete,
    });
    const updatedPeek = peekCachedAnalysis(cacheKey);
    return finalizeQuinielaPayload(
      built,
      {
        servedFrom: refresh ? "refresh" : "built",
        skippedBuild: false,
        storedAt: updatedPeek?.storedAt || Date.now(),
        expiresAt: updatedPeek?.expiresAt || null,
      },
      { persistReason: refresh ? "refresh" : "built" }
    );
  } catch (error) {
    if (storedForecast && quinielaPayloadIsComplete(storedForecast)) {
      return finalizeQuinielaPayload(
        storedForecast,
        {
          servedFrom: "disk-fallback",
          skippedBuild: true,
          buildError: error.message,
          storedAt: null,
          expiresAt: null,
        },
        { persistReason: "disk-fallback" }
      );
    }
    throw error;
  }
}
