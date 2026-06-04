import { round } from "../utils/math.js";
import {
  cacheOfficialQuinielaRows,
  isQuinielaPlazoCerrado,
  loadOfficialQuinielaCardCached,
  officialCardHasEnVentaComposition,
  peekOfficialQuinielaCardCached,
} from "./quiniela-official-cache.js";
import { notifyQuinielaOfficialProposal } from "./telegram-notifier.js";
import {
  footballPayloadUsableForQuiniela,
  loadEspnInsightsForQuiniela,
  loadFootballForQuiniela,
} from "./quiniela-request-cache.js";
import {
  loadFootballEvents,
  loadFootballOddsMulti,
} from "../providers/odds-api-io.js";
import { fifaRankingProbs } from "../providers/fifa-rankings.js";
import {
  buildFootballMatchBundle,
  bundleToMatchShape,
  indexFootballPartidos,
  resolveOfficialPartidoAgainstFootball,
} from "./quiniela-football-bridge.js";
import {
  MAX_QUINIELA_DOUBLES,
  applyQuinielaDoubleCap,
  applyQuinielaFijoOnly,
  applyAltitudeFactor,
  buildQuinielaFinalProbs,
  evaluateFijoDobleOptions,
  signsFromProbabilities,
} from "./quiniela-probability.js";
import { buildQuinielaPricingFromRows } from "../utils/quiniela-pricing.js";
import { buildPleno15Proposal } from "../utils/quiniela-pleno15.js";
import { getAppTimezone, getDateStringInTimezone } from "../utils/madrid-date.js";

const QUINIELA_OFFICIAL_URL = "https://www.loteriasyapuestas.es/es/resultados/quiniela";

// URLs a intentar en orden: la de resultados suele tener la sección "en venta",
// pero si no aparece la composición completa se intenta la página principal de la quiniela.
const QUINIELA_FUTBOL_INFO_URL = "https://www.quinielafutbol.info/proximas-jornadas-de-la-quiniela.html";

// Jina para SELAE; quinielafutbol también en HTML directo (Jina suele omitir la tabla de partidos).
const QUINIELA_SCRAPE_URLS = [
  `https://r.jina.ai/${QUINIELA_OFFICIAL_URL}`,
  `https://r.jina.ai/https://www.loteriasyapuestas.es/es/quiniela`,
  `https://r.jina.ai/${QUINIELA_FUTBOL_INFO_URL}`,
  QUINIELA_FUTBOL_INFO_URL,
];

// Índice de la última URL que devolvió composición válida.
// Se rota el orden en cada llamada para intentar primero la que más funciona.
let _lastSuccessfulUrlIndex = 0;

const SPANISH_MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function madridLocalToIso(dateKey, hour, minute) {
  const tz = getAppTimezone();
  const anchor = new Date(`${dateKey}T12:00:00Z`).getTime();
  for (let offsetMs = -14 * 3600000; offsetMs <= 14 * 3600000; offsetMs += 60_000) {
    const candidate = new Date(anchor + offsetMs);
    if (getDateStringInTimezone(candidate, tz) !== dateKey) continue;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(candidate);
    const h = Number(parts.find((part) => part.type === "hour")?.value);
    const m = Number(parts.find((part) => part.type === "minute")?.value);
    if (h === hour && m === minute) return candidate.toISOString();
  }
  return null;
}

function spanishMonthToNumber(monthName) {
  const key = String(monthName || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return SPANISH_MONTHS[key] || null;
}

function extractClosingTimeFromMarkdown(markdown) {
  const text = String(markdown || "");
  const fullMatch = text.match(
    /hasta el\s+(?:[a-záéíóúñ]+,\s*)?(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\s+a\s+las\s+(\d{1,2}):(\d{2})/i
  );
  if (fullMatch) {
    const month = spanishMonthToNumber(fullMatch[2]);
    if (month) {
      const dateKey = `${fullMatch[3]}-${String(month).padStart(2, "0")}-${String(fullMatch[1]).padStart(2, "0")}`;
      return madridLocalToIso(dateKey, Number(fullMatch[4]), Number(fullMatch[5]));
    }
  }

  const timeMatch = text.match(/hasta el[^.\n]{0,160}?(\d{1,2}):(\d{2})\s*h/i);
  if (timeMatch) {
    const dateKey = getDateStringInTimezone(new Date(), getAppTimezone());
    return madridLocalToIso(dateKey, Number(timeMatch[1]), Number(timeMatch[2]));
  }

  return null;
}

function parseSpanishDateKey(value) {
  const text = String(value || "");
  const match = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (!match) return null;
  return `${match[3]}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function parseKickoffIso(dateValue, timeValue) {
  const dateKey = parseSpanishDateKey(dateValue);
  const timeMatch = String(timeValue || "").match(/(\d{1,2}):(\d{2})/);
  if (!dateKey || !timeMatch) return null;
  return madridLocalToIso(dateKey, Number(timeMatch[1]), Number(timeMatch[2]));
}

function inferClosingTimeFromRows(rows = []) {
  const kickoffMs = rows
    .map((row) => new Date(row?.kickoffIso || "").getTime())
    .filter((value) => Number.isFinite(value));
  if (!kickoffMs.length) return null;
  return new Date(Math.min(...kickoffMs) - 15 * 60 * 1000).toISOString();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function buildUncertainOptions() {
  return {
    fijo: { pick: "1", ventajaPp: 0, prob: 0 },
    doble: { pick: "1X", ventajaPp: 0, prob: 0 },
    ventajaMayor: "doble",
    ventajaMayorPp: 0,
    ganadorClaro: false,
    isFijoEligible: false,
    sinGanadorClaro: true,
    needsDoubleScore: 1,
    confidence: 0,
    dataQuality: 0,
    disagreement: 0,
  };
}

function buildQuinielaPick(match, probs, index, assignment = null, finalResult = null) {
  const fijoOnly = Boolean(assignment?.fijoOnly);
  const signs = assignment?.signs || (probs ? signsFromProbabilities(probs) : []);
  const top = signs[0] || { sign: "1", p: 0 };
  const second = signs[1] || { sign: "X", p: 0 };
  const options = assignment?.options || (probs ? evaluateFijoDobleOptions(signs, finalResult) : buildUncertainOptions());
  const type = fijoOnly ? "fijo" : assignment?.type || (options.isFijoEligible ? "fijo" : "doble");
  const pick = fijoOnly
    ? options.fijo.pick
    : assignment?.pick || (type === "fijo" ? options.fijo.pick : options.doble.pick);
  const ventajaPp = fijoOnly
    ? options.fijo.ventajaPp
    : assignment?.ventajaPp || (type === "fijo" ? options.fijo.ventajaPp : options.doble.ventajaPp);
  const estado = fijoOnly
    ? options.ganadorClaro
      ? "verde"
      : "amarillo"
    : type === "fijo"
      ? "verde"
      : "amarillo";
  const confidence = round((fijoOnly || type === "fijo" ? top.p : top.p + second.p) * 100, 0);
  const edge = probs ? round((top.p - second.p) * 100, 1) : 0;
  const dataQuality = round((finalResult?.dataQuality ?? options.dataQuality ?? 0) * 100, 0);
  const modelConfidence = round((finalResult?.confidence ?? options.confidence ?? 0) * 100, 0);
  const disagreementPp = round((finalResult?.disagreement ?? options.disagreement ?? 0) * 100, 1);
  const method = finalResult?.method || "no-data";
  const home = match?.homeTeam?.name || "Local";
  const away = match?.awayTeam?.name || "Visitante";
  const partidoLabel = `${home} vs ${away}`;
  const ventajaIcon = options.ventajaMayor === "fijo" ? "★" : "⚡";
  const fijoForzadoPorCupo = fijoOnly ? false : Boolean(assignment?.fijoForzadoPorCupo);
  const fijoForzadoIcon = "🔒";
  const favoritoSign = top.sign;
  const favoritoProbPct = round(top.p * 100, 0);
  const altType = type === "fijo" ? "doble" : "fijo";
  const altPick = altType === "fijo" ? options.fijo.pick : options.doble.pick;
  const altVentaja = altType === "fijo" ? options.fijo.ventajaPp : options.doble.ventajaPp;
  const lineMovement = finalResult?.lineMovement || match?.lineMovementMl || null;
  const lineTrapActive = Boolean(finalResult?.lineTrapOnFavorite);
  const lineTrapDetected = lineMovement?.tipo === "LINEA_TRAMPA";
  const lineMovementNote = finalResult?.lineMovementNote || null;
  const pctPublicHome = match?.lineMovementInput?.pct_tickets_home ?? null;
  const pctPublicAway = match?.lineMovementInput?.pct_tickets_away ?? null;
  const lmRationaleSuffix = lineMovementNote ? ` ${lineMovementNote}` : "";

  return {
    id: `quiniela-${match.id}-${index + 1}`,
    matchId: String(match.id),
    partido: partidoLabel,
    pick_label: pick,
    selection: pick,
    mercado: "Quiniela 1X2",
    market: "Quiniela 1X2",
    estado,
    confianza: confidence,
    ev: round(top.p - second.p, 3),
    evPercent: `+${edge}%`,
    rationale:
      probs
        ? fijoOnly
          ? `Boleto mínimo (solo fijos): ${pick} es el signo con mayor probabilidad del modelo. ` +
            `1=${Math.round(probs.p1 * 100)}% · X=${Math.round(probs.px * 100)}% · 2=${Math.round(probs.p2 * 100)}% (${method}). ` +
            `Calidad ${dataQuality}% · confianza ${modelConfidence}% · ventaja fijo ${ventajaPp} pp sobre 2ª opción. ` +
            (options.ganadorClaro
              ? "Ganador claro según umbrales del modelo."
              : "Partido dudoso: en el boleto modelo iría doble, aquí se juega un solo signo para coste mínimo.")
          : `Pronóstico ${pick}: 1=${Math.round(probs.p1 * 100)}% · X=${Math.round(probs.px * 100)}% · 2=${Math.round(probs.p2 * 100)}% (${method}). ` +
            `Calidad ${dataQuality}% · confianza ${modelConfidence}% · desacuerdo modelo/mercado ${disagreementPp} pp. ` +
            `${type.toUpperCase()} asignado (ventaja ${ventajaPp} pp). ` +
            (fijoForzadoPorCupo
              ? `Fijo forzado ${fijoForzadoIcon}: cupo de dobles lleno; se decanta por favorito ${favoritoSign} (${favoritoProbPct}%). Prefería doble ${options.doble.pick} ${ventajaIcon}. `
              : `Mayor ventaja: ${options.ventajaMayor.toUpperCase()} ${ventajaIcon} (${options.ventajaMayorPp} pp). `) +
            `Alternativa ${altType}: ${altPick} (${altVentaja} pp).${lmRationaleSuffix}`
        : fijoOnly
          ? `Sin datos fiables: se marca fijo ${pick} por defecto (boleto mínimo, un signo por partido).`
          : `Sin datos suficientes para estimar 1X2 con fiabilidad. Se prioriza doble si hay cupo (riskScore alto).${lmRationaleSuffix}`,
    line_movement: lineMovement,
    lineTrapActive,
    lineTrapDetected,
    lineMovementNote,
    pct_public_home: pctPublicHome,
    pct_public_away: pctPublicAway,
    quinielaSign: favoritoSign,
    betSide: favoritoSign === "1" ? "home" : favoritoSign === "2" ? "away" : null,
    valueLabel: fijoOnly
      ? options.ganadorClaro
        ? "Fijo · ganador claro"
        : "Fijo · signo favorito"
      : fijoForzadoPorCupo
        ? `Fijo forzado · favorito ${favoritoSign}`
        : type === "fijo"
          ? "Fijo en boleto"
          : "Doble en boleto",
    verdictLabel: fijoOnly
      ? options.ganadorClaro
        ? "Fijo claro"
        : "Fijo único (mínimo)"
      : fijoForzadoPorCupo
        ? `Fijo forzado ${fijoForzadoIcon} · favorito ${favoritoSign}`
        : type === "fijo"
          ? "Señal fuerte"
          : "Cobertura sugerida",
    quiniela: {
      order: index + 1,
      type,
      signs,
      probs,
      edgePp: edge,
      dataQuality,
      modelConfidence,
      disagreementPp,
      probabilityMethod: method,
      ventajaMayor: options.ventajaMayor,
      ventajaMayorIcon: ventajaIcon,
      ventajaMayorPp: options.ventajaMayorPp,
      opcionFijo: options.fijo,
      opcionDoble: options.doble,
      alternativa: { type: altType, pick: altPick, ventajaPp: altVentaja },
      enBoleto: type,
      fijoForzadoPorCupo,
      fijoForzadoIcon,
      favoritoSign,
      favoritoProbPct,
      decantadoPorFavorito: fijoForzadoPorCupo,
      fijoOnly,
      ganadorClaro: fijoOnly ? Boolean(options.ganadorClaro) : type === "fijo" && !fijoForzadoPorCupo,
      lineTrapOnFavorite: lineTrapActive,
      lineMovementTipo: lineMovement?.tipo || null,
    },
  };
}

function buildPropuestaRowFromPartido(partido, idx, { soloFijos = false } = {}) {
  const q = partido?.picks?.[0]?.quiniela || {};
  const p0 = partido?.picks?.[0] || {};
  const tipo = soloFijos ? "fijo" : q.type || "fijo";
  const pick = partido?.picks?.[0]?.selection || q.opcionFijo?.pick || "1";
  return {
    order: idx + 1,
    partido: `${partido.home} vs ${partido.away}`,
    pick,
    tipo,
    confianza: partido?.picks?.[0]?.confianza ?? null,
    explicacion: partido?.picks?.[0]?.rationale || "",
    ventajaMayor: q.ventajaMayor || null,
    ventajaMayorIcon: q.ventajaMayorIcon || null,
    ventajaMayorPp: q.ventajaMayorPp ?? null,
    dataQuality: q.dataQuality ?? null,
    modelConfidence: q.modelConfidence ?? null,
    probabilityMethod: q.probabilityMethod || null,
    valorEstadistico: Boolean(q.probs && (q.dataQuality ?? 0) >= 45),
    opcionFijo: q.opcionFijo?.pick || q.opcionFijo || null,
    opcionDoble: q.opcionDoble?.pick || q.opcionDoble || null,
    fijoVentajaPp: q.opcionFijo?.ventajaPp ?? null,
    dobleVentajaPp: q.opcionDoble?.ventajaPp ?? null,
    fijoForzadoPorCupo: soloFijos ? false : Boolean(q.fijoForzadoPorCupo),
    fijoForzadoIcon: soloFijos ? null : q.fijoForzadoIcon || null,
    favoritoSign: q.favoritoSign || null,
    favoritoProbPct: q.favoritoProbPct ?? null,
    decantadoPorFavorito: soloFijos ? false : Boolean(q.decantadoPorFavorito),
    ganadorClaro: Boolean(q.ganadorClaro),
    soloFijos,
    categoriaBoleto: soloFijos ? "fijo_unico" : q.fijoForzadoPorCupo ? "fijo_forzado" : tipo === "doble" ? "doble" : "fijo_natural",
    lineTrapActive: Boolean(p0.lineTrapActive ?? q.lineTrapOnFavorite),
    lineTrapDetected: Boolean(p0.lineTrapDetected ?? q.lineMovementTipo === "LINEA_TRAMPA"),
    line_movement: p0.line_movement || null,
    lineMovementNote: p0.lineMovementNote || null,
    pct_public_home: p0.pct_public_home ?? null,
    pct_public_away: p0.pct_public_away ?? null,
    quinielaSign: q.favoritoSign || null,
    betSide: p0.betSide || null,
    dataSource: partido.quinielaMeta?.dataSource || partido.quinielaMeta?.bridgeSource || "no-data",
    probabilities: q.probs ? {
      p1Pct: Math.round((q.probs.p1 ?? 0) * 100),
      pxPct: Math.round((q.probs.px ?? 0) * 100),
      p2Pct: Math.round((q.probs.p2 ?? 0) * 100),
    } : null,
    altitudeFlag: partido.quinielaMeta?.altitudeFlag || null,
    rankHome: partido.quinielaMeta?.rankHome ?? null,
    rankAway: partido.quinielaMeta?.rankAway ?? null,
    flags: partido.quinielaMeta?.flags || [],
  };
}

function buildPropuestaFromPartidos(partidos, { soloFijos = false } = {}) {
  return partidos.map((partido, idx) => buildPropuestaRowFromPartido(partido, idx, { soloFijos }));
}

function finalizeQuinielaPicks(rawCandidates, { fijoOnly = false } = {}) {
  const withOptions = rawCandidates.map((item, index) => {
    const hasProbs = Boolean(item.probs && item.signs?.length);
    return {
      index,
      match: item.match,
      bundle: item.bundle,
      finalResult: item.finalResult,
      probs: item.probs,
      isPlaceholder: item.isPlaceholder,
      options: hasProbs
        ? evaluateFijoDobleOptions(item.signs, item.finalResult)
        : buildUncertainOptions(),
      signs: item.signs,
    };
  });
  const assigned = fijoOnly ? applyQuinielaFijoOnly(withOptions) : applyQuinielaDoubleCap(withOptions);
  return assigned.map((item, index) => {
    let pick = buildQuinielaPick(item.match, item.probs, index, {
      options: item.options,
      type: item.type,
      pick: item.pick,
      ventajaPp: item.ventajaPp,
      fijoForzadoPorCupo: item.fijoForzadoPorCupo,
      signs: item.signs,
      fijoOnly,
    }, item.finalResult);
    if (!fijoOnly && item.isPlaceholder && pick.quiniela?.type !== "doble") {
      pick = {
        ...pick,
        estado: "amarillo",
        verdictLabel: "Datos limitados — doble por defecto si cupo",
        rationale: `Datos limitados para ${pick.partido}. Sin probabilidades fiables; se usa la mejor cobertura disponible.`,
      };
    }
    return pick;
  });
}

function parseOfficialJornadaMeta(markdown) {
  const jornadaInSale = markdown.match(/Jornada\s+(\d+)ª\s+[A-Za-zÁÉÍÓÚáéíóú]+,\s*(\d{2}\/\d{2}\/\d{4})/);
  const closingTime = extractClosingTimeFromMarkdown(markdown);
  return {
    jornada: jornadaInSale ? Number(jornadaInSale[1]) : null,
    fecha: jornadaInSale ? jornadaInSale[2] : null,
    closingTime,
  };
}

function resolveJornadaNumber(markdown) {
  const patterns = [
    /Jornada\s+(\d+)[ªa°]\s+en\s+venta/i,
    /J(\d+)[ªa°]\s+en\s+venta/i,
    /JORNADA\s+N[ºo°]\s*(\d+)/i,
    /jornada\s+(\d+)\s+de\s+la\s+quiniela/i,
    /La\s+Quiniela:\s*jornada\s+(\d+)/i,
    /pr[oó]xima\s+jornada[\s\S]{0,160}?Jornada\s+(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function extractQuinielaTableRows(text) {
  const seen = new Set();
  const rows = [];

  const scheduledTableRowPattern =
    /\|\s*(\d{1,2})\.?\s*\|\s*([^|\r\n]{2,}?)\s*-\s*([^|\r\n]{2,}?)\s*\|\s*([^|\r\n]*\d{1,2}[/-]\d{1,2}[/-]\d{4}[^|\r\n]*)\s*\|\s*([^|\r\n]*\d{1,2}:\d{2}[^|\r\n]*)\s*\|/g;
  let match;
  while ((match = scheduledTableRowPattern.exec(text)) !== null) {
    const order = Number(match[1]);
    if (order < 1 || order > 15 || seen.has(order)) continue;
    const home = match[2].trim();
    const away = match[3].trim();
    const dateLabel = match[4].trim();
    const timeLabel = match[5].trim();
    if (!home || !away) continue;
    seen.add(order);
    rows.push({
      order,
      home,
      away,
      dateLabel,
      timeLabel,
      kickoffIso: parseKickoffIso(dateLabel, timeLabel),
    });
  }

  // | 1. | Local - Visitante |  o  | 1 | Local - Visitante | fecha | hora |
  const tableRowPattern = /\|\s*(\d{1,2})\.?\s*\|\s*([^|\r\n]{2,}?)\s*-\s*([^|\r\n]{2,}?)\s*\|/g;
  while ((match = tableRowPattern.exec(text)) !== null) {
    const order = Number(match[1]);
    if (order < 1 || order > 15 || seen.has(order)) continue;
    const home = match[2].trim();
    const away = match[3].trim();
    if (!home || !away) continue;
    seen.add(order);
    rows.push({ order, home, away });
  }

  if (rows.length < 14) {
    const textRowPattern = /^\s*(\d{1,2})\.\s+(.{2,}?)\s+-\s+(.{2,}?)\s*$/gm;
    while ((match = textRowPattern.exec(text)) !== null) {
      const order = Number(match[1]);
      if (order < 1 || order > 15 || seen.has(order)) continue;
      const home = match[2].trim();
      const away = match[3].trim();
      if (!home || !away) continue;
      seen.add(order);
      rows.push({ order, home, away });
    }
  }

  rows.sort((left, right) => left.order - right.order);
  return rows;
}

// Parsea la jornada en venta (próxima). Devuelve null si no hay composición — nunca inventa datos.
function parseEnVentaBlock(markdown) {
  const headerMatch =
    markdown.match(/Jornada\s+(\d+)[ªa°]\s+en\s+venta/i) ||
    markdown.match(/J(\d+)[ªa°]\s+en\s+venta/i) ||
    markdown.match(/JORNADA\s+N[ºo°]\s*(\d+)/i);

  let jornada = headerMatch ? Number(headerMatch[1]) : resolveJornadaNumber(markdown);
  if (!jornada) return null;

  let chunk = markdown;
  if (headerMatch) {
    const sectionStart = headerMatch.index || 0;
    const completedBlockIdx = markdown.search(/La Quiniela\s*-\s*J\d+/i);
    const nextJornadaIdx = markdown.slice(sectionStart + 1).search(/##\s*JORNADA\s+N[ºo°]/i);
    let sectionEnd = markdown.length;
    if (completedBlockIdx > sectionStart) sectionEnd = Math.min(sectionEnd, completedBlockIdx);
    if (nextJornadaIdx >= 0) sectionEnd = Math.min(sectionEnd, sectionStart + 1 + nextJornadaIdx);
    chunk = markdown.slice(sectionStart, sectionEnd);
  }

  let rows = extractQuinielaTableRows(chunk);
  if (rows.length < 14) rows = extractQuinielaTableRows(markdown);

  const mainRows = rows.filter((row) => row.order >= 1 && row.order <= 14);
  if (mainRows.length < 14) return null;
  const inferredClosingTime = inferClosingTimeFromRows(mainRows);

  const row15 = rows.find((row) => row.order === 15);
  const pleno =
    chunk.match(/\|\s*P-?15\.?\s*\|\s*([^|]+?)\s*-\s*([^|]+?)\s*\|/i) ||
    chunk.match(/P-?15\.?\s+(.{2,}?)\s+-\s+(.{2,}?)\s*$/im) ||
    markdown.match(/Pleno\s+al\s+15[^.]{0,80}?([A-Za-zÀ-ÿ0-9.\s]+?)\s+-\s+([A-Za-zÀ-ÿ0-9.\s]+?)(?:\s+a\s+las|\s+que\s+actúa|\.)/i);

  return {
    jornada,
    rows: mainRows.slice(0, 14),
    closingTime:
      extractClosingTimeFromMarkdown(chunk) ||
      extractClosingTimeFromMarkdown(markdown) ||
      inferredClosingTime,
    pleno15: pleno
      ? { home: pleno[1].trim(), away: pleno[2].trim() }
      : row15
        ? { home: row15.home, away: row15.away }
        : null,
  };
}

function parseOfficialCompletedBlocks(markdown) {
  const blocks = [];
  const headerRegex = /La Quiniela - J(\d+)ª[\s\S]*?Jornada\s+\d+ª/g;
  const headers = [...markdown.matchAll(headerRegex)];
  if (!headers.length) return blocks;

  for (let i = 0; i < headers.length; i += 1) {
    const start = headers[i].index || 0;
    const end = i + 1 < headers.length ? (headers[i + 1].index || markdown.length) : markdown.length;
    const chunk = markdown.slice(start, end);
    const jornada = Number(headers[i][1]);

    const rows = [...chunk.matchAll(/\|\s*(\d+)\.\s*\|\s*([^|]+?)\s*-\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([12X])\s*\|/g)]
      .map((m) => ({
        order: Number(m[1]),
        home: m[2].trim(),
        away: m[3].trim(),
        score: String(m[4] || "").trim() || null,
        resultado: String(m[5] || "").trim().toUpperCase() || null,
      }))
      .sort((a, b) => a.order - b.order);

    const pleno = chunk.match(/\|\s*P-?15\.?\s*\|\s*([^|]+?)\s*-\s*([^|]+?)\s*\|/i);
    if (rows.length > 0) {
      blocks.push({
        jornada,
        rows: rows.slice(0, 14),
        pleno15: pleno ? { home: pleno[1].trim(), away: pleno[2].trim() } : null,
      });
    }
  }
  return blocks.sort((a, b) => b.jornada - a.jornada);
}

function htmlToParseableText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh][^>]*>/gi, "| ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

async function fetchQuinielaPageText(url) {
  const viaJina = url.includes("r.jina.ai/");
  const response = await fetch(url, {
    headers: {
      "User-Agent": "danny-pick/quiniela-module",
      Accept: viaJina
        ? "text/plain,text/markdown;q=0.9,*/*;q=0.8"
        : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}`);
  const body = await response.text();
  return viaJina ? body : htmlToParseableText(body);
}

function describeQuinielaScrapeSource(url) {
  const normalized = String(url || "");
  if (normalized.includes("loteriasyapuestas.es")) {
    return { label: "Loterías y Apuestas (SELAE)", isFallback: false };
  }
  if (normalized.includes("quinielafutbol.info")) {
    return { label: "quinielafutbol.info (composición publicada)", isFallback: true };
  }
  return { label: normalized.replace(/^https:\/\/r\.jina\.ai\//, "") || "desconocida", isFallback: true };
}

async function loadOfficialQuinielaCard() {
  let markdown = null;
  let scrapeUrl = null;
  let lastError = null;

  // Rotar orden de URLs: intentar primero la que tuvo éxito la última vez
  const orderedUrls = [
    ...QUINIELA_SCRAPE_URLS.slice(_lastSuccessfulUrlIndex),
    ...QUINIELA_SCRAPE_URLS.slice(0, _lastSuccessfulUrlIndex),
  ];

  for (const url of orderedUrls) {
    try {
      const raw = await fetchQuinielaPageText(url);
      const candidate = parseEnVentaBlock(raw);
      if (candidate?.rows?.length >= 14) {
        markdown = raw;
        scrapeUrl = url;
        _lastSuccessfulUrlIndex = QUINIELA_SCRAPE_URLS.indexOf(url);
        console.log(`[quiniela] composicion en venta encontrada (J${candidate.jornada}) via ${url}`);
        break;
      }
      // La URL respondió pero no tiene la composición publicada aún
      if (!markdown) markdown = raw; // guardar el primer raw como fallback para meta/completed
      console.log(`[quiniela] ${url} no contiene composicion en venta (${candidate?.rows?.length ?? 0} filas)`);
    } catch (err) {
      lastError = err;
      console.warn(`[quiniela] fallo al leer ${url}:`, err.message);
    }
  }

  if (!markdown) throw new Error(`No se pudo leer ninguna URL de quiniela. Último error: ${lastError?.message}`);

  const meta = parseOfficialJornadaMeta(markdown);
  const enVenta = parseEnVentaBlock(markdown);
  const completed = parseOfficialCompletedBlocks(markdown);
  if (enVenta && !enVenta.closingTime) {
    enVenta.closingTime =
      meta?.closingTime || extractClosingTimeFromMarkdown(markdown);
  }

  console.log(`[quiniela] meta jornada=${meta.jornada} | enVenta=${enVenta ? `J${enVenta.jornada} (${enVenta.rows.length} filas)` : "null"} | completed=${completed.length} bloques`);

  const source = describeQuinielaScrapeSource(scrapeUrl);
  return {
    meta,
    enVenta,
    completed,
    markdown,
    scrapeUrl,
    scrapeSourceLabel: source.label,
    scrapeSourceFallback: source.isFallback,
  };
}

/** Normaliza nombre de equipo para fuzzy matching con eventos de Odds-API.io. */
function _normTeam(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrae las cuotas ML (home/draw/away) de un entry de odds/multi. */
function _extractMlOddsFromOddsEntry(oddsEntry) {
  const bookmakers = oddsEntry?.bookmakers;
  if (!bookmakers || typeof bookmakers !== "object") return null;
  const books = Array.isArray(bookmakers) ? bookmakers : Object.values(bookmakers);
  for (const book of books) {
    const ml = book?.ML || book?.winner || book?.moneyline;
    if (!ml) continue;
    const home = Number(ml.home ?? ml[0] ?? 0);
    const draw = Number(ml.draw ?? ml.tie ?? ml[2] ?? 0);
    const away = Number(ml.away ?? ml[1] ?? 0);
    if (home > 1 && draw > 1 && away > 1) {
      return { home, draw, away, books: [book.bookmaker || book.name || "market"] };
    }
  }
  return null;
}

/**
 * Enriquece los pickCandidates inciertos con cuotas de Odds-API.io.
 * Muta candidates en su lugar; recomputa finalResult/probs/signs si encuentra cuotas.
 */
async function _enrichUncertainBundlesWithOdds(candidates, footballEvents) {
  const uncertainOnes = candidates.filter((c) => c.isPlaceholder);
  if (!uncertainOnes.length || !footballEvents.length) return;

  // Fuzzy match: nombre de equipo contra eventos de Odds-API.io
  const matchedEventIds = [];
  const matchedIndices = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.isPlaceholder) continue;
    const homeN = _normTeam(c.bundle.home);
    const awayN = _normTeam(c.bundle.away);
    if (!homeN || !awayN) continue;

    let bestEvent = null;
    let bestScore = 0;
    for (const event of footballEvents) {
      const h = _normTeam(event.home || event.homeTeam || "");
      const a = _normTeam(event.away || event.awayTeam || "");
      const hTokens = homeN.split(" ").filter((t) => t.length > 2);
      const aTokens = awayN.split(" ").filter((t) => t.length > 2);
      const hMatch = h.includes(homeN) || homeN.includes(h) ? 1
        : hTokens.some((t) => h.includes(t)) ? 0.5 : 0;
      const aMatch = a.includes(awayN) || awayN.includes(a) ? 1
        : aTokens.some((t) => a.includes(t)) ? 0.5 : 0;
      const score = (hMatch + aMatch) / 2;
      if (score >= 0.5 && score > bestScore) {
        bestScore = score;
        bestEvent = event;
      }
    }

    if (bestEvent) {
      const eventId = bestEvent.id || bestEvent.eventId;
      matchedEventIds.push(eventId);
      matchedIndices.push(i);
    }
  }

  if (!matchedEventIds.length) return;

  const oddsData = await loadFootballOddsMulti(matchedEventIds).catch(() => []);
  if (!oddsData.length) return;

  for (let j = 0; j < matchedIndices.length; j++) {
    const candIdx = matchedIndices[j];
    const eventId = matchedEventIds[j];
    const oddsEntry = oddsData.find((o) => o.id === eventId || o.eventId === eventId);
    if (!oddsEntry) continue;
    const mlOdds = _extractMlOddsFromOddsEntry(oddsEntry);
    if (!mlOdds) continue;

    // Enriquecer el bundle con las cuotas encontradas
    const candidate = candidates[candIdx];
    candidate.bundle = {
      ...candidate.bundle,
      mlOdds,
      dataSource: "odds-only",
      isPlaceholder: false,
    };

    // Recomputar probabilidades con el bundle enriquecido
    const finalResult = buildQuinielaFinalProbs(candidate.bundle);
    const probs = finalResult.probs;
    if (probs) {
      candidate.finalResult = finalResult;
      candidate.probs = probs;
      candidate.signs = signsFromProbabilities(probs);
      candidate.isPlaceholder = false;
    }
  }
}

export async function buildQuinielaAnalysis(date) {
  const officialPeek = peekOfficialQuinielaCardCached();
  const officialFromCache = Boolean(
    (officialPeek?.isFresh || officialPeek?.isStaleUsable) &&
      officialCardHasEnVentaComposition(officialPeek?.value)
  );

  const [footballResult, official] = await Promise.all([
    loadFootballForQuiniela(date),
    officialFromCache
      ? Promise.resolve(officialPeek.value)
      : loadOfficialQuinielaCardCached(() => loadOfficialQuinielaCard()).catch(() => null),
  ]);
  const football = footballResult.data;
  // Usar exclusivamente la jornada "en venta" (próxima). Los bloques históricos NO se usan
  // para evitar proponer sobre una jornada ya jugada.
  const targetOfficial = official?.enVenta || null;

  if (targetOfficial?.rows?.length) {
    cacheOfficialQuinielaRows(targetOfficial.rows);
  }

  if (!targetOfficial?.rows?.length) {
    return {
      app: "DANNY PICK",
      module: "Quiniela Desk",
      sport: "quiniela",
      date,
      generatedAt: new Date().toISOString(),
      dataAvailable: false,
      unavailableReason: "La composición oficial de la jornada en venta aún no está publicada en Loterías.",
      partidos_analizados: 0,
      partidos: [],
      picks: [],
      slateSummary: {
        matchesToday: 0,
        matchesAnalyzed: 0,
        readyRecommendations: 0,
        officialCardDetected: false,
        officialJornada: official?.meta?.jornada || null,
      },
      methodology: {
        principle: "Solo se analiza la Quiniela oficial publicada por Loterías.",
        scoring: "Fijo si hay ganador claro. Doble solo sin ganador claro (hasta 4, no obligatorios).",
        note: "Esperando publicación de partidos oficiales de la jornada en venta.",
      },
      officialSource: {
        url: QUINIELA_OFFICIAL_URL,
        scrapeUrl: official?.scrapeUrl || null,
        scrapeSourceLabel: official?.scrapeSourceLabel || null,
        scrapeSourceFallback: official?.scrapeSourceFallback ?? null,
        jornadaEnVenta: official?.meta?.jornada || null,
        jornadaAnalizada: null,
        cardDetected: false,
        pleno15: null,
      },
      riskNotes: ["Sin composición oficial en venta, no se generan propuestas para evitar señales sobre jornadas pasadas."],
    };
  }

  const footballUsable = footballPayloadUsableForQuiniela(football);
  const byPair = footballUsable ? indexFootballPartidos(football.partidos) : new Map();
  const officialRows = targetOfficial?.rows || [];

  const cardRows = officialRows.map((row, idx) => ({
    order: row.order || idx + 1,
    home: row.home,
    away: row.away,
    dateLabel: row.dateLabel || null,
    timeLabel: row.timeLabel || null,
    kickoffIso: row.kickoffIso || null,
  }));

  const unmatchedRows = cardRows.filter((row) => !resolveOfficialPartidoAgainstFootball(row, byPair));
  const espnResult = await loadEspnInsightsForQuiniela({
    jornada: targetOfficial?.jornada,
    unmatchedRows,
    date,
  }).catch(() => ({ data: {}, layer: "error", skippedRemoteBuild: false }));
  const espnDirect = espnResult.data || {};

  // Cargar eventos de Odds-API.io para el fallback de cuotas
  const footballEvents = await loadFootballEvents().catch(() => []);

  const pickCandidates = cardRows.map((entry, index) => {
    const bundle = buildFootballMatchBundle(entry, byPair, espnDirect);
    const finalResult = buildQuinielaFinalProbs(bundle);
    const probs = finalResult.probs;
    const signs = probs ? signsFromProbabilities(probs) : [];
    const match = bundleToMatchShape(bundle);
    return {
      match,
      bundle,
      finalResult,
      probs,
      signs,
      isPlaceholder: Boolean(finalResult.uncertain || !probs),
      index,
    };
  });

  // Q-1: Enriquecer bundles sin datos con cuotas de Odds-API.io
  await _enrichUncertainBundlesWithOdds(pickCandidates, footballEvents);

  // Q-4: Fallback FIFA ranking para bundles que siguen sin datos
  for (const candidate of pickCandidates) {
    if (!candidate.isPlaceholder || candidate.probs) continue;
    const { bundle } = candidate;
    const homeTeam = bundle.home || "";
    const awayTeam = bundle.away || "";
    const fifaResult = fifaRankingProbs(homeTeam, awayTeam);
    if (fifaResult) {
      const { p1, px, p2 } = fifaResult;
      candidate.probs = { p1, px, p2 };
      candidate.signs = signsFromProbabilities({ p1, px, p2 });
      candidate.isPlaceholder = false;
      candidate.finalResult = {
        ...candidate.finalResult,
        probs: { p1, px, p2 },
        method: "fifa-ranking-only",
        dataQuality: 0.20,
        confidence: 0.30,
        rankHome: fifaResult.rankHome,
        rankAway: fifaResult.rankAway,
        rankDiff: fifaResult.rankDiff,
      };
      candidate.bundle = { ...bundle, dataSource: "fifa-ranking-only" };
    }
  }

  // Q-3: Aplicar factor altitud sobre probs finales (después de todos los fallbacks)
  for (const candidate of pickCandidates) {
    if (!candidate.probs) continue;
    const homeTeam = candidate.bundle.home || "";
    const venueCity = candidate.bundle.venueCity || "";
    const { probs: altProbs, altitudeFlag } = applyAltitudeFactor(candidate.probs, homeTeam, venueCity);
    if (altitudeFlag) {
      candidate.probs = altProbs;
      candidate.signs = signsFromProbabilities(altProbs);
      candidate.altitudeFlag = altitudeFlag;
      candidate.bundle = {
        ...candidate.bundle,
        flags: [...(candidate.bundle.flags || []), "HIGH_ALTITUDE_MATCH"],
        altitudeFlag,
      };
    }
  }

  const finalizedPicks = finalizeQuinielaPicks(pickCandidates);
  const finalizedPicksMinima = finalizeQuinielaPicks(pickCandidates, { fijoOnly: true });

  const partidos = cardRows.map((entry, index) => {
    const candidate = pickCandidates[index];
    const match = candidate.match;
    const probs = candidate.probs;
    const pick = finalizedPicks[index];
    const finalResult = candidate.finalResult;
    return {
      eventId: match.id || `official-${index + 1}`,
      home: entry.home || match.homeTeam?.name || "Local",
      away: entry.away || match.awayTeam?.name || "Visitante",
      liga: `Quiniela · J${targetOfficial.jornada}`,
      hora: entry.kickoffIso || match.scheduledAt || match.date || null,
      status: match.status || "scheduled",
      stadium: match.stadium || null,
      referee: match.referee || null,
      homeTeam: match.homeTeam || null,
      awayTeam: match.awayTeam || null,
      matchModel: probs
        ? {
            ...(match.matchModel || {}),
            model_home_prob: probs.p1,
            model_draw_prob: probs.px,
            model_away_prob: probs.p2,
          }
        : match.matchModel || {},
      quinielaMeta: {
        dataQuality: finalResult?.dataQuality ?? null,
        confidence: finalResult?.confidence ?? null,
        disagreement: finalResult?.disagreement ?? null,
        method: finalResult?.method || null,
        bridgeSource: candidate.bundle?.bridgeSource || null,
        dataSource: candidate.bundle?.dataSource || "no-data",
        uncertain: Boolean(finalResult?.uncertain || !probs),
        lineMovement: finalResult?.lineMovement?.tipo || null,
        lineTrapOnFavorite: Boolean(finalResult?.lineTrapOnFavorite),
        forceDouble: Boolean(finalResult?.forceDouble),
        altitudeFlag: candidate.altitudeFlag || null,
        rankHome: finalResult?.rankHome ?? null,
        rankAway: finalResult?.rankAway ?? null,
        flags: candidate.bundle?.flags || [],
      },
      picks: [pick],
      sin_valor: pick.estado === "sin_valor" ? [pick] : [],
      officialOrder: entry.order,
    };
  });

  const partidosMinima = cardRows.map((entry, index) => {
    const base = partidos[index];
    return {
      ...base,
      picks: [finalizedPicksMinima[index]],
    };
  });

  let propuestaPleno15 = null;
  const plenoMeta = targetOfficial?.pleno15;
  if (plenoMeta?.home && plenoMeta?.away) {
    const plenoCardRow = { order: 15, home: plenoMeta.home, away: plenoMeta.away };
    const plenoBundle = buildFootballMatchBundle(plenoCardRow, byPair, espnDirect);
    const plenoFinal = buildQuinielaFinalProbs(plenoBundle);
    propuestaPleno15 = buildPleno15Proposal({
      home: plenoMeta.home,
      away: plenoMeta.away,
      bundle: plenoBundle,
      finalResult: plenoFinal,
    });
  }

  const picks = partidos.flatMap((p) => p.picks);
  const picksMinima = partidosMinima.flatMap((p) => p.picks);
  const fixed = picks.filter((p) => p.quiniela?.type === "fijo").length;
  const doubles = picks.filter((p) => p.quiniela?.type === "doble").length;
  const forcedFijos = picks.filter((p) => p.quiniela?.fijoForzadoPorCupo).length;
  const fixedMinima = picksMinima.length;
  const statValueRows = picks.filter(
    (p) => p.quiniela?.probs && Number(p.quiniela?.dataQuality || 0) >= 45
  ).length;
  const lowDataRows = Math.max(0, picks.length - statValueRows);

  const result = {
    app: "DANNY PICK",
    module: "Quiniela Desk",
    sport: "quiniela",
    date: football.date || date,
    generatedAt: new Date().toISOString(),
    dataAvailable: true,
    partidos_analizados: partidos.length,
    partidos,
    picks,
    picksMinima,
    partidosMinima,
    top5_jornada: picks
      .slice()
      .sort((a, b) => (b.quiniela?.edgePp || 0) - (a.quiniela?.edgePp || 0))
      .slice(0, 5),
    methodology: {
      principle: "Capa quiniela: bridge fútbol + modelo ESPN/API-Sports + cuotas ML + dropping odds + line movement (trampa/RLM en 1X2).",
      scoring: "Fijo natural: top ≥50%, edge ≥12 pp, confianza ≥70%, desacuerdo modelo/mercado ≤12 pp. Dobles por riskScore (máx. 4).",
      minimal:
        "Boleto mínimo: un solo signo por partido (siempre la opción fijo del modelo). Sin dobles ni cupo forzado. Importe reglamentario 1,50 €.",
      note: `Boleto en venta J${targetOfficial.jornada}. Sin placeholder PPG si calidad <45%. Fuente: ${official?.scrapeSourceLabel || QUINIELA_OFFICIAL_URL}`,
    },
    slateSummary: {
      matchesToday: football?.partidos?.length || football?.matches?.length || 0,
      matchesAnalyzed: partidos.length,
      readyRecommendations: picks.length,
      fixed,
      doubles,
      forcedFijos,
      fixedMinima,
      doublesMinima: 0,
      statValueRows,
      lowDataRows,
      maxDoubles: MAX_QUINIELA_DOUBLES,
      officialCardDetected: Boolean(targetOfficial),
      officialJornada: targetOfficial?.jornada || official?.meta?.jornada || null,
      footballUsable,
      footballFromSharedCache: Boolean(footballResult.skippedRemoteBuild),
      footballCacheFresh: footballResult.layer === "fresh",
      footballPartidos: footballUsable ? football.partidos.length : 0,
    },
    runtime: {
      footballCacheKey: `futbol:${date}`,
      footballUsable,
      footballFromSharedCache: Boolean(footballResult.skippedRemoteBuild),
      footballCacheLayer: footballResult.layer || null,
      officialCardCached: officialFromCache,
      officialCardLayer: officialPeek?.isFresh ? "fresh" : officialPeek?.isStaleUsable ? "stale" : "built",
      espnInsightsLayer: espnResult.layer || null,
      espnInsightsSkipped: Boolean(espnResult.skippedRemoteBuild),
      espnUnmatchedCount: unmatchedRows.length,
    },
    riskNotes: [
      "Los dobles no son obligatorios: se asignan por riskScore global en partidos sin fijo natural (hasta 4).",
      "Desacuerdo modelo vs mercado >12 pp reduce confianza y favorece doble.",
      "Sin datos fiables (calidad <45%) no se inventan probabilidades por PPG.",
      ...(lowDataRows
        ? [
            `${lowDataRows}/14 signos no tienen edge estadistico suficiente: se muestran como cobertura de boleto, no como valor.`,
          ]
        : []),
      ...(footballUsable
        ? []
        : [
            "Módulo fútbol sin partidos en caché: pronósticos vía bridge ESPN directo sobre el boleto oficial.",
          ]),
    ],
    // No exponer matches de fútbol: la UI de Quiniela solo debe listar data.partidos (boleto oficial).
    matches: [],
    officialSource: {
      url: QUINIELA_OFFICIAL_URL,
      scrapeUrl: official?.scrapeUrl || null,
      scrapeSourceLabel: official?.scrapeSourceLabel || null,
      scrapeSourceFallback: official?.scrapeSourceFallback ?? false,
      jornadaEnVenta: official?.enVenta?.jornada || official?.meta?.jornada || null,
      jornadaAnalizada: targetOfficial?.jornada || null,
      cardDetected: Boolean(targetOfficial),
      pleno15: targetOfficial?.pleno15 || null,
      closingTime:
        targetOfficial?.closingTime ||
        official?.enVenta?.closingTime ||
        official?.meta?.closingTime ||
        null,
      plazoCerrado: false,
    },
    propuestaPleno15,
    propuestaOficial: buildPropuestaFromPartidos(partidos),
    propuestaMinima: buildPropuestaFromPartidos(partidosMinima, { soloFijos: true }),
  };

  const pricing = buildQuinielaPricingFromRows(result.propuestaOficial, {
    minimalRows: result.propuestaMinima,
  });
  result.pricing = pricing;
  result.slateSummary.costEurModelo = pricing.direct.costEur;
  result.slateSummary.costEurMinimo = pricing.minimal.costEur;
  result.slateSummary.combinacionesModelo = pricing.direct.combinationsPerColumn;
  result.slateSummary.combinacionesMinimo = pricing.minimal.combinationsPerColumn;

  result.officialSource.plazoCerrado = isQuinielaPlazoCerrado(result.officialSource);
  result.completedBlocks = official?.completed || [];

  result.telegramPayload = {
    jornada: result.officialSource?.jornadaAnalizada,
    propuesta: result.propuestaOficial || [],
    propuestaMinima: result.propuestaMinima || [],
    pricing: result.pricing || null,
    pleno15: result.officialSource?.pleno15 || null,
    propuestaPleno15: result.propuestaPleno15 || null,
    closingTime: result.officialSource?.closingTime || null,
  };

  if (!result.officialSource.plazoCerrado) {
    notifyQuinielaOfficialProposal(result.telegramPayload).catch(() => {});
  }

  return result;
}

/**
 * Obtiene resultados oficiales publicados para una jornada concreta.
 */
export async function fetchOfficialQuinielaCompleted(jornada) {
  if (!jornada) return null;

  let official = null;
  try {
    official = await loadOfficialQuinielaCard();
  } catch {
    official = await loadOfficialQuinielaCardCached(() => loadOfficialQuinielaCard()).catch(() => null);
  }

  const block = (official?.completed || []).find(
    (entry) => Number(entry.jornada) === Number(jornada)
  );
  if (!block?.rows?.length) return null;

  return block.rows.map((row) => ({
    order: row.order,
    partido: `${row.home} - ${row.away}`,
    home: row.home,
    away: row.away,
    resultado: row.resultado || null,
    marcador: row.score || row.marcador || null,
  }));
}

/**
 * Diagnóstico: muestra exactamente qué encuentra el parser en la página de Loterías.
 * Útil para verificar si la composición "en venta" ya fue publicada y qué formato tiene.
 */
export { parseEnVentaBlock };

export async function debugQuinielaCard() {
  let lastError = null;
  const attempts = [];

  for (const url of QUINIELA_SCRAPE_URLS) {
    try {
      const markdown = await fetchQuinielaPageText(url);
      const meta = parseOfficialJornadaMeta(markdown);
      const enVenta = parseEnVentaBlock(markdown);
      const completed = parseOfficialCompletedBlocks(markdown);

      attempts.push({
        url,
        ok: true,
        meta,
        enVenta: enVenta
          ? { jornada: enVenta.jornada, filas: enVenta.rows.length, pleno15: Boolean(enVenta.pleno15), partidos: enVenta.rows }
          : null,
        completedBlocks: completed.map((b) => ({ jornada: b.jornada, filas: b.rows.length })),
        // Primeros 500 chars del markdown para ver el formato real de la página
        markdownPreview: markdown.slice(0, 500),
      });
    } catch (err) {
      lastError = err;
      attempts.push({ url, ok: false, error: err.message });
    }
  }

  const composicionEncontrada = attempts.some((a) => a.enVenta?.filas >= 14);

  return {
    composicionEncontrada,
    mensaje: composicionEncontrada
      ? `Composición en venta detectada correctamente.`
      : `La composición aún no está publicada o el formato de la página no coincide con el parser.`,
    attempts,
    consejo: composicionEncontrada
      ? null
      : `Revisar markdownPreview para ver el formato real. Si los partidos aparecen pero no se parsean, ajustar el regex en parseEnVentaBlock.`,
  };
}
