import { attachLineTrapFlags } from "./line-trap-flags.js";
import { calibrateForDisplay, calibrateForScoring } from "./pick-calibration.js";
import { detectLineMovement } from "./line-movement-engine.js";
import { getOddsHarvesterMatchContext } from "./oddsharvester-snapshot.js";
import { openingLineForMarket } from "./pro-market-quotes.js";
import {
  calcularScore,
  computeDataQuality,
  evFromProbability,
  evaluateValueGates,
  impliedProbabilityFromDecimal,
  isDropAlignedWithPick,
  logValueGateFailure,
  marketAnchorBlend,
  resolvePickColor,
} from "./pro-odds-scoring.js";
import { clamp, round } from "../utils/math.js";
import {
  FOOTBALL_THRESHOLDS,
  applyDataQualityPenalties,
  resolveColorWithSportThresholds,
} from "./sport-bettable-thresholds.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";

const ODDS_RANGE = FOOTBALL_THRESHOLDS.oddsRange;

function readBook(odds, bookName) {
  if (!odds || typeof odds !== "object") return {};
  const candidates = [bookName, String(bookName), String(bookName).toLowerCase(), canonicalName(bookName)].filter(Boolean);
  for (const key of candidates) {
    if (odds[key]) return odds[key];
  }

  const desired = canonicalName(bookName);
  for (const [key, book] of Object.entries(odds)) {
    if (canonicalName(key) === desired) return book || {};
  }
  return {};
}

function pickBestSideOdds(odds, mercado, side) {
  let best = null;
  for (const book of ["Bet365", "Winamax FR", "bet365", "Winamax"]) {
    const value = Number.parseFloat(readBook(odds, book)?.[mercado]?.[side] || 0);
    if (Number.isFinite(value) && value > 1 && (!best || value > best)) best = value;
  }
  return best;
}

function readTotalsLine(odds) {
  for (const book of ["Bet365", "Winamax FR", "bet365", "Winamax"]) {
    const hdp = Number.parseFloat(readBook(odds, book)?.Totals?.hdp || 0);
    if (Number.isFinite(hdp) && hdp > 0) return hdp;
  }
  return null;
}

export function pickFootballMarketQuote(odds = {}, marketKey) {
  if (marketKey === "moneyline") {
    const home = pickBestSideOdds(odds, "ML", "home");
    const away = pickBestSideOdds(odds, "ML", "away");
    const draw = pickBestSideOdds(odds, "ML", "draw");
    const b365Home = Number.parseFloat(readBook(odds, "Bet365")?.ML?.home || 0);
    const wmxHome = Number.parseFloat(readBook(odds, "Winamax FR")?.ML?.home || readBook(odds, "Winamax")?.ML?.home || 0);
    const gap = b365Home > 1 && wmxHome > 1 ? Math.abs(1 / b365Home - 1 / wmxHome) : 0;
    return { home, away, draw, line: null, over: home, under: away, gap };
  }

  if (marketKey === "game_total") {
    const line = readTotalsLine(odds);
    const over = pickBestSideOdds(odds, "Totals", "over");
    const under = pickBestSideOdds(odds, "Totals", "under");
    const b365Over = Number.parseFloat(readBook(odds, "Bet365")?.Totals?.over || 0);
    const wmxOver = Number.parseFloat(readBook(odds, "Winamax FR")?.Totals?.over || readBook(odds, "Winamax")?.Totals?.over || 0);
    const gap = b365Over > 1 && wmxOver > 1 ? Math.abs(1 / b365Over - 1 / wmxOver) : 0;
    return { line, over, under, gap };
  }

  if (marketKey === "asian_handicap") {
    const line = Number.parseFloat(readBook(odds, "Bet365")?.Spread?.hdp || readBook(odds, "Winamax FR")?.Spread?.hdp || 0);
    const home = pickBestSideOdds(odds, "Spread", "home");
    const away = pickBestSideOdds(odds, "Spread", "away");
    return { line, home, away, over: home, under: away, gap: 0 };
  }

  return { line: null, over: null, under: null, gap: 0 };
}

export function mercadoToMarketKey(mercado) {
  const map = {
    ML: "moneyline",
    Totals: "game_total",
    Spread: "asian_handicap",
    "Double Chance": "double_chance",
  };
  return map[mercado] || null;
}

export function footballProFlags(baseCtx = {}, insight = null, odds = {}) {
  const src = String(baseCtx?.__source || "").toLowerCase();
  const flags = {
    stats_espn_disponibles: src.includes("espn"),
    mercado_actualizado: Boolean(odds && Object.keys(odds).length > 0),
    alineacion_confirmada: Boolean(baseCtx?.lineup_confirmed),
    lesiones_confirmadas: Array.isArray(baseCtx?.lesiones) && baseCtx.lesiones.length > 0,
    h2h_relevante: Boolean(insight?.h2h),
    clima_disponible: false,
    xg_disponible: Number.isFinite(baseCtx?.model_goals_home) && Number.isFinite(baseCtx?.model_goals_away),
    muestra_suficiente: Number.isFinite(baseCtx?.model_home_prob),
    freshness_ok: Boolean(odds && Object.keys(odds).length > 0),
  };
  return {
    ...flags,
    datos_parciales: !flags.alineacion_confirmada || !flags.xg_disponible,
  };
}

export function computeFootballModelProb({ mercado, betSide, baseCtx, odds, impliedProb = null }) {
  const mHome = baseCtx?.model_home_prob;
  const mDraw = baseCtx?.model_draw_prob;
  const mAway = baseCtx?.model_away_prob;
  const mGoalsTotal = (baseCtx?.model_goals_home ?? 0) + (baseCtx?.model_goals_away ?? 0);

  if (mercado === "ML" && betSide === "home" && Number.isFinite(mHome)) return mHome;
  if (mercado === "ML" && betSide === "away" && Number.isFinite(mAway)) return mAway;
  if (mercado === "ML" && betSide === "draw" && Number.isFinite(mDraw)) return mDraw;
  if (mercado === "Double Chance" && betSide === "1X" && Number.isFinite(mHome) && Number.isFinite(mDraw)) {
    return clamp(mHome + mDraw, 0.3, 0.97);
  }
  if (mercado === "Double Chance" && betSide === "X2" && Number.isFinite(mDraw) && Number.isFinite(mAway)) {
    return clamp(mDraw + mAway, 0.3, 0.97);
  }
  if (mercado === "Totals" && mGoalsTotal > 0) {
    const goalLine = readTotalsLine(odds) ?? 2.5;
    return betSide === "over"
      ? clamp(mGoalsTotal / (goalLine + mGoalsTotal), 0.25, 0.88)
      : clamp(goalLine / (goalLine + mGoalsTotal), 0.25, 0.88);
  }
  if (Number.isFinite(impliedProb)) return clamp(impliedProb, 0.08, 0.92);
  return null;
}

export async function buildFootballLineMovementInput({
  home,
  away,
  odds,
  mlOdds = null,
  eventId = null,
  scheduleDate = null,
  startTime = null,
}) {
  const matchCtx = { home, away, sport: "football", eventId, scheduleDate, startTime };
  const [lmMl, lmTotal] = await Promise.all([
    getOddsHarvesterMatchContext({ ...matchCtx, marketKey: "moneyline" }),
    getOddsHarvesterMatchContext({ ...matchCtx, marketKey: "game_total" }),
  ]);

  const ml = mlOdds || {
    home: pickBestSideOdds(odds, "ML", "home"),
    away: pickBestSideOdds(odds, "ML", "away"),
    draw: pickBestSideOdds(odds, "ML", "draw"),
  };
  const totalsLine = readTotalsLine(odds);
  const lmSource = lmMl?.source || lmTotal?.source || "odds-fallback";
  const publicSplitsAvailable = /draftkings|sportsbettingdime|public-splits/i.test(String(lmSource));

  return {
    pct_tickets_home: lmMl?.pct_tickets_home ?? 50,
    pct_tickets_away:
      lmMl?.pct_tickets_away ??
      (lmMl?.pct_tickets_home != null ? round(100 - Number(lmMl.pct_tickets_home), 1) : 50),
    pct_money_home: lmMl?.pct_money_home ?? 50,
    cuota_apertura_home: lmMl?.cuota_apertura_home ?? ml?.home ?? null,
    cuota_actual_home: ml?.home ?? null,
    cuota_apertura_away: lmMl?.cuota_apertura_away ?? ml?.away ?? null,
    cuota_actual_away: ml?.away ?? null,
    linea_apertura: lmTotal?.linea_apertura ?? totalsLine,
    linea_actual: totalsLine,
    lm_source: lmSource,
    public_splits_available: publicSplitsAvailable,
  };
}

export function detectFootballLineMovement(lineMovementInput, marketKey, odds = {}) {
  if (!lineMovementInput?.public_splits_available) {
    return {
      tipo: "NEUTRO",
      score_bonus: 0,
      score_penalizacion_si_vas_publico: 0,
      marketKey,
      source: lineMovementInput?.lm_source || "sin_splits",
      reason: "sin_splits_publicos_futbol",
    };
  }

  const quote = pickFootballMarketQuote(odds, marketKey);
  const lines = openingLineForMarket(lineMovementInput, marketKey, quote, {});
  return detectLineMovement({
    pct_tickets_home: lineMovementInput?.pct_tickets_home ?? 50,
    pct_money_home: lineMovementInput?.pct_money_home ?? 50,
    hay_noticia_lesion: false,
    sport: "football",
    marketKey,
    ...lines,
  });
}

function lineMovementRationale(lm, pickSideLm) {
  if (!lm || lm.tipo === "NEUTRO" || lm.tipo === "NOTICIA") return null;
  if (lm.tipo === "LINEA_TRAMPA") {
    if (pickSideLm === lm.lado_publico) {
      return "Trampa detectada: mucha gente apuesta por este lado y la cuota empeoró; el modelo desaconseja esta apuesta.";
    }
    return "Trampa detectada: la multitud va al otro lado; puede haber mejor opción en el lado contrario.";
  }
  if (lm.tipo === "RLM") {
    return pickSideLm === lm.lado_sharp
      ? "Reverse line movement: el dinero inteligente apoya este lado."
      : "RLM en contra del pick: el mercado se mueve contra esta selección.";
  }
  if (lm.tipo === "STEAM_MOVE") {
    return pickSideLm === lm.lado_sharp ? "Steam move alineado con el pick." : "Steam move en dirección contraria al pick.";
  }
  return null;
}

function resolvePickSideLm(mercado, betSide) {
  if (mercado === "ML" || mercado === "Spread") return betSide;
  if (mercado === "Totals") return betSide;
  if (mercado === "Double Chance") {
    if (betSide === "1X") return "home";
    if (betSide === "X2") return "away";
  }
  return betSide;
}

function resolveOddsRangeKey(marketKey) {
  return ODDS_RANGE[marketKey] ? marketKey : "moneyline";
}

export function enrichFootballPickWithProScoring(pick, ctx = {}) {
  const {
    odds = {},
    baseCtx = {},
    insight = null,
    lineMovementInput = {},
    drop = null,
    valueBetApplied = false,
  } = ctx;

  const mercado = pick.mercado;
  const betSide = pick.betSide;
  const marketKey = mercadoToMarketKey(mercado);
  if (!marketKey) return pick;

  const oddsTaken = Number(pick.mejor_cuota || pick.bestOdds || 0);
  if (!Number.isFinite(oddsTaken) || oddsTaken <= 1) return pick;

  const probMarket = impliedProbabilityFromDecimal(oddsTaken);
  const modelProb = computeFootballModelProb({
    mercado,
    betSide,
    baseCtx,
    odds,
    impliedProb: probMarket,
  });
  if (modelProb == null) return pick;

  const edge = modelProb - probMarket;
  const evRaw = evFromProbability(modelProb, oddsTaken);
  const evModel = calibrateForScoring(evRaw);
  const evDisplay = calibrateForDisplay(evRaw);
  const externalEvRaw = Number.isFinite(Number(pick.ev)) ? Number(pick.ev) : null;
  const externalEv =
    externalEvRaw != null && Math.abs(externalEvRaw) > 0.12
      ? calibrateForScoring(externalEvRaw)
      : externalEvRaw;
  const marketHasNativeModel = mercado === "ML" || mercado === "Double Chance" || mercado === "Totals";
  const evForScoring =
    Number.isFinite(externalEv) && (!marketHasNativeModel || (Number.isFinite(evModel) && Math.abs(evModel) < 0.0005))
      ? externalEv
      : evModel;
  if (evForScoring == null) return pick;

  const lm =
    marketKey === "game_total"
      ? detectFootballLineMovement(lineMovementInput, "game_total", odds)
      : detectFootballLineMovement(lineMovementInput, "moneyline", odds);

  const pickSideLm = resolvePickSideLm(mercado, betSide);
  const drop12h = drop?.odds?.drop?.["12h"] || pick.drop_12h || 0;
  const droppingAligned = isDropAlignedWithPick(
    { dropping: drop12h >= 5, dropBetSide: drop?.betSide },
    pickSideLm
  );

  const flags = footballProFlags(baseCtx, insight, odds);
  const dataQuality = applyDataQualityPenalties(
    computeDataQuality(flags, { oddsAvailable: true, freshnessOk: true }),
    FOOTBALL_THRESHOLDS.dataQualityPenalties,
    flags,
    "football"
  );
  const rangeKey = resolveOddsRangeKey(marketKey);
  const range = ODDS_RANGE[rangeKey] || ODDS_RANGE.moneyline;
  const cuota_en_rango = oddsTaken >= range.min && oddsTaken <= range.max;

  const scoreResult = calcularScore({
    ev_modelo: evForScoring,
    ev_externo_coincide: Boolean(valueBetApplied || pick.senalDoble),
    dropping_alineado: droppingAligned,
    gap_books: pick.gap || 0,
    cuota_en_rango,
    dataQuality,
    n_senales: (valueBetApplied ? 1 : 0) + (droppingAligned ? 1 : 0),
    lm,
    pick_side: pickSideLm,
    confianza: pick.confianza ?? 55,
  });

  if (scoreResult.discarded) {
    return {
      ...pick,
      color: "gris",
      score: 0,
      edge: round(edge, 3),
      ev_model: evModel,
      prob_model: modelProb,
      prob_market: probMarket,
      line_movement: lm,
      lineMovementNote: scoreResult.discarded?.razon || lineMovementRationale(lm, pickSideLm),
      bettable: false,
      proBettable: false,
      estado: "sin_valor",
      value_gates: { passed: false, failures: ["rlm_contra"] },
    };
  }

  const anchor = marketAnchorBlend(modelProb, probMarket);
  const confianza = scoreResult.confianza + anchor.confianzaDelta;
  const requireEdge = marketKey === "moneyline";

  const sportColor = resolveColorWithSportThresholds(FOOTBALL_THRESHOLDS, {
    ev: evForScoring,
    signals: {
      valueBet: Boolean(valueBetApplied || pick.senalDoble),
      dropping: droppingAligned,
      gapBooks: pick.gap || 0,
    },
    lm,
    pickSideLm,
    flags,
  });

  const color = resolvePickColor({
    score: scoreResult.score,
    ev: evForScoring,
    edge,
    cuota_en_rango,
    umbralVerde: sportColor.umbralVerde,
    umbralAmarillo: sportColor.umbralAmarillo,
    evVerde: sportColor.evVerde,
    evAmarillo: sportColor.evAmarillo,
    edgeVerde: sportColor.edgeVerde,
    edgeAmarillo: sportColor.edgeAmarillo,
    requireEdge,
  });

  const valueGates = evaluateValueGates({
    ev: evForScoring,
    edge,
    dataQuality,
    cuota_en_rango,
    lm,
    pickSide: pickSideLm,
    probModel: anchor.prob,
    probMarket,
    requireEdge,
    flags,
    confidence: Math.max(0, Math.min(100, confianza)),
    ...sportColor.gateParams,
  });

  logValueGateFailure("FOOTBALL", {
    game: baseCtx,
    marketKey,
    scoreResult,
    ev: evForScoring,
    evRaw,
    dataQuality,
    cuota_en_rango,
    edge,
    valueGates,
  });

  const proBettable = (color === "verde" || color === "amarillo") && valueGates.passed;
  const enriched = attachLineTrapFlags(
    {
      ...pick,
      color,
      score: scoreResult.score,
      score_final: scoreResult.score,
      edge: round(edge, 3),
      edgePercent: round(edge * 100, 1),
      ev_model: evForScoring,
      ev_display: evDisplay,
      ev_raw: evRaw,
      prob_model: anchor.prob,
      prob_market: probMarket,
      data_quality: dataQuality,
      confidence: Math.max(0, Math.min(100, confianza)),
      line_movement: lm,
      value_gates: valueGates,
      proBettable,
      market_anchor_applied: anchor.applied,
      lineMovementNote: lineMovementRationale(lm, pickSideLm),
      pct_public_home: lineMovementInput?.pct_tickets_home ?? null,
      pct_public_away: lineMovementInput?.pct_tickets_away ?? null,
    },
    lm,
    pickSideLm
  );

  let estado = pick.estado;
  if (enriched.lineTrapActive && (estado === "verde" || estado === "amarillo")) {
    estado = "amarillo";
    enriched.verdictLabel = "Trampa de línea: el público va contra el valor real";
  } else if (proBettable && color === "verde" && estado !== "verde") {
    estado = "verde";
  } else if (proBettable && color === "amarillo" && (estado === "sin_valor" || estado === "modelo")) {
    estado = "amarillo";
  } else if (!proBettable && color === "gris" && enriched.lineTrapActive) {
    estado = "sin_valor";
  }

  enriched.estado = estado;
  const valueBettable = !enriched.lineTrapActive && (estado === "verde" || (estado === "amarillo" && proBettable));
  enriched.bettable = valueBettable;
  enriched.proBettable = proBettable;
  enriched.valueBettable = valueBettable;
  enriched.valueModeApplied = valueBettable && estado === "amarillo";

  const note = enriched.lineMovementNote;
  if (note && !String(enriched.rationale || "").includes(note.slice(0, 24))) {
    enriched.rationale = [enriched.rationale, note].filter(Boolean).join(" ");
  }

  return enriched;
}

export async function enrichFootballPartidoWithPro({ evento, odds, baseCtx, insight, mlOdds, drop, picks, sin_valor }) {
  const lineMovementInput = await buildFootballLineMovementInput({
    home: evento.home,
    away: evento.away,
    odds,
    mlOdds,
    eventId: evento.id,
    scheduleDate: String(evento.date || "").slice(0, 10),
    startTime: evento.date,
  });
  const lineMovementMl = detectFootballLineMovement(lineMovementInput, "moneyline", odds);
  const ctx = { odds, baseCtx, insight, lineMovementInput, drop };
  return {
    lineMovementInput,
    lineMovementMl,
    picks: picks.map((p) => enrichFootballPickWithProScoring(p, { ...ctx, valueBetApplied: Boolean(p.valueBetApplied) })),
    sin_valor: sin_valor.map((p) => enrichFootballPickWithProScoring(p, ctx)),
  };
}
