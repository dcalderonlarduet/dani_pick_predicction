/**
 * Actualiza los resultados de la Quiniela sin recalcular el pronostico.
 */

import { loadWithCache } from "../providers/shared/resource-cache.js";
import { fetchOfficialQuinielaCompleted } from "./quiniela-analyzer.js";

const RESULTS_NAMESPACE = "quiniela-results";
const RESULTS_TTL_MS = 12 * 60 * 1000;
const RESULTS_STALE_MS = 48 * 60 * 60 * 1000;

export async function fetchQuinielaResultados(jornada) {
  if (!jornada) return null;

  const cacheKey = `resultados:j${jornada}`;
  return loadWithCache(
    RESULTS_NAMESPACE,
    cacheKey,
    { ttlMs: RESULTS_TTL_MS, staleMs: RESULTS_STALE_MS },
    async () => {
      try {
        return await fetchOfficialQuinielaCompleted(jornada);
      } catch (error) {
        console.warn("[quiniela-results] Error obteniendo resultados:", error.message);
        return null;
      }
    }
  );
}

function normalizeSigns(value) {
  const raw = String(value || "").toUpperCase();
  const compact = raw.replace(/[^12X]/g, "");
  if (compact) return [...new Set(compact.split(""))];
  return raw
    .split(/[\/,\s]+/)
    .map((sign) => sign.trim().toUpperCase())
    .filter(Boolean);
}

function indexResultados(resultados = []) {
  const byOrder = new Map();
  for (const row of resultados || []) {
    const order = Number(row?.order);
    if (!Number.isFinite(order)) continue;
    byOrder.set(order, row);
  }
  return byOrder;
}

function evaluateRow(row, resultado) {
  if (!resultado?.resultado) {
    return {
      ...row,
      resultadoReal: null,
      marcador: null,
      acierto: null,
      estadoResultado: "pendiente",
    };
  }

  const resultadoReal = String(resultado.resultado || "").trim().toUpperCase();
  const signosJugados = normalizeSigns(row?.pick || row?.selection || row?.pick_label);
  const acierto = signosJugados.includes(resultadoReal);
  return {
    ...row,
    resultadoReal,
    marcador: resultado.marcador || resultado.score || null,
    acierto,
    estadoResultado: acierto ? "acertado" : "fallado",
  };
}

function attachResultadoToPick(pick, byOrder) {
  const order = Number(pick?.quiniela?.order ?? pick?.order);
  if (!Number.isFinite(order)) return pick;
  const enriched = evaluateRow(
    {
      order,
      pick: pick?.selection || pick?.pick_label,
    },
    byOrder.get(order)
  );
  return {
    ...pick,
    resultadoReal: enriched.resultadoReal,
    marcador: enriched.marcador,
    acierto: enriched.acierto,
    estadoResultado: enriched.estadoResultado,
  };
}

function attachResultadoToPartido(partido, byOrder) {
  const order = Number(partido?.officialOrder);
  if (!Number.isFinite(order)) return partido;
  const resultado = byOrder.get(order);
  const base = evaluateRow({ order, pick: partido?.picks?.[0]?.selection }, resultado);
  return {
    ...partido,
    resultadoReal: base.resultadoReal,
    marcador: base.marcador,
    acierto: base.acierto,
    estadoResultado: base.estadoResultado,
    picks: Array.isArray(partido?.picks)
      ? partido.picks.map((pick) => attachResultadoToPick(pick, byOrder))
      : partido?.picks,
  };
}

export function evaluateQuinielaPronostico(propuesta = [], resultados = []) {
  if (!propuesta.length || !resultados.length) return null;

  let aciertos = 0;
  let fallos = 0;
  let pendientes = 0;
  const detalle = [];

  for (const row of propuesta.slice(0, 14)) {
    const resultado = resultados.find((entry) => Number(entry.order) === Number(row.order));

    if (!resultado?.resultado) {
      pendientes += 1;
      detalle.push({ ...row, acierto: null, resultadoReal: null, estadoResultado: "pendiente" });
      continue;
    }

    const signosJugados = normalizeSigns(row.pick);
    const acertado = signosJugados.includes(String(resultado.resultado).toUpperCase());
    if (acertado) aciertos += 1;
    else fallos += 1;

    detalle.push({
      ...row,
      acierto: acertado,
      resultadoReal: resultado.resultado,
      marcador: resultado.marcador,
      estadoResultado: acertado ? "acertado" : "fallado",
    });
  }

  return {
    aciertos,
    fallos,
    pendientes,
    total: 14,
    detalle,
  };
}

export function mergeQuinielaResultados(analysis, resultados = [], { source = "official" } = {}) {
  if (!analysis || typeof analysis !== "object") return analysis;
  const rows = Array.isArray(resultados) ? resultados : [];
  const byOrder = indexResultados(rows);
  const propuesta = Array.isArray(analysis.propuestaOficial) ? analysis.propuestaOficial : [];
  const evaluacion = evaluateQuinielaPronostico(propuesta, rows);
  const updatedAt = new Date().toISOString();

  if (!evaluacion) {
    return {
      ...analysis,
      resultadosQuiniela: {
        jornada: analysis?.officialSource?.jornadaAnalizada || null,
        source,
        rows,
        updatedAt,
      },
    };
  }

  const propuestaOficial = propuesta.map((row) => evaluateRow(row, byOrder.get(Number(row?.order))));
  const propuestaMinima = Array.isArray(analysis.propuestaMinima)
    ? analysis.propuestaMinima.map((row) => evaluateRow(row, byOrder.get(Number(row?.order))))
    : analysis.propuestaMinima;
  const picks = Array.isArray(analysis.picks)
    ? analysis.picks.map((pick) => attachResultadoToPick(pick, byOrder))
    : analysis.picks;
  const picksMinima = Array.isArray(analysis.picksMinima)
    ? analysis.picksMinima.map((pick) => attachResultadoToPick(pick, byOrder))
    : analysis.picksMinima;
  const partidos = Array.isArray(analysis.partidos)
    ? analysis.partidos.map((partido) => attachResultadoToPartido(partido, byOrder))
    : analysis.partidos;
  const partidosMinima = Array.isArray(analysis.partidosMinima)
    ? analysis.partidosMinima.map((partido) => attachResultadoToPartido(partido, byOrder))
    : analysis.partidosMinima;

  return {
    ...analysis,
    propuestaOficial,
    propuestaMinima,
    picks,
    picksMinima,
    partidos,
    partidosMinima,
    evaluacionResultados: evaluacion,
    resultadosQuiniela: {
      jornada: analysis?.officialSource?.jornadaAnalizada || null,
      source,
      rows,
      updatedAt,
      resolved: evaluacion.total - evaluacion.pendientes,
      pending: evaluacion.pendientes,
      hits: evaluacion.aciertos,
      misses: evaluacion.fallos,
    },
    slateSummary: {
      ...(analysis.slateSummary || {}),
      resultadosPublicados: rows.filter((row) => row?.resultado).length,
      resultadosPendientes: evaluacion.pendientes,
      aciertosQuiniela: evaluacion.aciertos,
      fallosQuiniela: evaluacion.fallos,
    },
  };
}

export async function refreshQuinielaResultadosForAnalysis(analysis, { force = false } = {}) {
  const jornada = analysis?.officialSource?.jornadaAnalizada;
  if (!jornada) return analysis;
  if (!force && Number(analysis?.evaluacionResultados?.pendientes) === 0) return analysis;
  const resultados = await fetchQuinielaResultados(jornada);
  if (!resultados?.length) return analysis;
  return mergeQuinielaResultados(analysis, resultados, { source: "official" });
}
