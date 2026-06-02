import { round } from "../utils/math.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";

const _cfg = getRuntimeConfig();
const DEFAULT_SHARP_BOOK = _cfg.sharpBook ?? "Bet365";
const DEFAULT_RETAIL_BOOK = _cfg.retailBook ?? "Winamax FR";

function titleCase(value) {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function displayBookmakerName(key) {
  const normalized = canonicalName(key);
  if (!normalized) return null;
  if (normalized === canonicalName(DEFAULT_SHARP_BOOK)) return DEFAULT_SHARP_BOOK;
  if (normalized === canonicalName(DEFAULT_RETAIL_BOOK)) return DEFAULT_RETAIL_BOOK;
  return titleCase(normalized);
}

export function formatEventSchedule(isoValue, meta = {}) {
  const tournament = meta.tournament || "";
  const round = meta.round || "";
  const venue = meta.venue || meta.stadium || "";

  if (!isoValue) {
    const fallback = [tournament, round, venue].filter(Boolean).join(" Â· ");
    return {
      tournament,
      round,
      venue,
      dateLabel: "Fecha por confirmar",
      timeLabel: "",
      display: fallback || "Horario pendiente",
    };
  }

  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return {
      tournament,
      round,
      venue,
      dateLabel: "Fecha por confirmar",
      timeLabel: "",
      display: tournament || "Horario pendiente",
    };
  }

  const dateLabel = date.toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const timeLabel = date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  const display = [tournament, round, dateLabel, timeLabel, venue].filter(Boolean).join(" Â· ");

  return {
    tournament,
    round,
    venue,
    dateLabel,
    timeLabel,
    iso: isoValue,
    display,
  };
}

export function findWinamaxBookmakerKey(bookmakers = {}) {
  for (const key of Object.keys(bookmakers)) {
    if (canonicalName(key).includes("winamax")) {
      return key;
    }
  }
  return null;
}

export function findPreferredBookmakerKey(bookmakers = {}, desiredName = "") {
  const desired = canonicalName(desiredName);
  if (!desired) return null;

  for (const key of Object.keys(bookmakers)) {
    const normalized = canonicalName(key);
    if (normalized === desired || normalized.includes(desired) || desired.includes(normalized)) {
      return key;
    }
  }

  return null;
}

function pickBestOdd(candidates) {
  return candidates.reduce((best, entry) => {
    if (!Number.isFinite(entry?.odd)) return best;
    if (!best || entry.odd > best.odd) return entry;
    return best;
  }, null);
}

export function extractTennisOdd(bookmakers, bookmakerKey, marketType, selectionIndex = 0) {
  const market = bookmakers?.[bookmakerKey];
  if (!market) return null;

  if (marketType === "winner") {
    const odd = market.winner?.[selectionIndex];
    return Number.isFinite(odd) ? odd : null;
  }
  if (marketType === "totals_over") {
    return Number.isFinite(market.totals?.over) ? market.totals.over : null;
  }
  if (marketType === "totals_under") {
    return Number.isFinite(market.totals?.under) ? market.totals.under : null;
  }
  return null;
}

export function extractMlbOdd(bookmakers, bookmakerKey, type, side, line = null) {
  const market = bookmakers?.[bookmakerKey];
  if (!market) return null;

  if (type === "moneyline") {
    const odd = side === "home" ? market.winner?.[0] : market.winner?.[1];
    return Number.isFinite(odd) ? odd : null;
  }
  if (type === "totals-over") {
    return Number.isFinite(market.totals?.over) ? market.totals.over : null;
  }
  if (type === "totals-under") {
    return Number.isFinite(market.totals?.under) ? market.totals.under : null;
  }
  if (type === "runline") {
    const odd = side === "home" ? market.spreads?.home : market.spreads?.away;
    return Number.isFinite(odd) ? odd : null;
  }
  if (type === "team-total-home-over" || type === "team-total-home-under") {
    const teamMarket = market.teamTotalHome;
    if (!teamMarket) return null;
    if (Number.isFinite(line) && Number.isFinite(teamMarket.line) && Math.abs(teamMarket.line - line) > 0.01) {
      return null;
    }
    const odd = type.endsWith("-over") ? teamMarket.over : teamMarket.under;
    return Number.isFinite(odd) ? odd : null;
  }
  if (type === "team-total-away-over" || type === "team-total-away-under") {
    const teamMarket = market.teamTotalAway;
    if (!teamMarket) return null;
    if (Number.isFinite(line) && Number.isFinite(teamMarket.line) && Math.abs(teamMarket.line - line) > 0.01) {
      return null;
    }
    const odd = type.endsWith("-over") ? teamMarket.over : teamMarket.under;
    return Number.isFinite(odd) ? odd : null;
  }
  return null;
}

export function tennisMarketSpecFromRecommendation(recommendation) {
  if (recommendation.type === "winner") {
    return {
      sport: "tennis",
      market: "winner",
      selectionIndex: recommendation.selectionIndex ?? 0,
    };
  }
  if (recommendation.type === "totals") {
    const isOver = String(recommendation.id || "").includes("-over") || /mas de/i.test(recommendation.selection || "");
    return {
      sport: "tennis",
      market: isOver ? "totals_over" : "totals_under",
      selectionIndex: 0,
    };
  }
  return { sport: "tennis", market: "winner", selectionIndex: 0 };
}

export function mlbMarketSpecFromRecommendation(recommendation) {
  if (recommendation.type === "moneyline") {
    return { sport: "mlb", type: "moneyline", side: recommendation.teamSide || "home" };
  }
  if (recommendation.type === "totals") {
    const isOver = String(recommendation.id || "").includes("-over") || /mas de/i.test(recommendation.selection || "");
    return { sport: "mlb", type: isOver ? "totals-over" : "totals-under", side: "home" };
  }
  if (recommendation.type === "team-total") {
    const wantsOver = Boolean(recommendation.wantsOver);
    const type =
      recommendation.side === "away"
        ? wantsOver
          ? "team-total-away-over"
          : "team-total-away-under"
        : wantsOver
          ? "team-total-home-over"
          : "team-total-home-under";
    return {
      sport: "mlb",
      type,
      side: recommendation.side || "home",
      line: Number.isFinite(recommendation.line) ? recommendation.line : null,
    };
  }
  if (recommendation.type === "runline") {
    return { sport: "mlb", type: "runline", side: recommendation.teamSide || "home" };
  }
  return { sport: "mlb", type: "moneyline", side: "home" };
}

function buildGapSignal(sharpOdd, retailOdd) {
  if (!Number.isFinite(sharpOdd) || !Number.isFinite(retailOdd)) {
    return {
      oddsGap: null,
      gapTier: "unavailable",
      valueBook: null,
      valueOdd: null,
      confidenceBoost: 0,
      label: "Sin comparativa sharp/retail",
      summary: "No hay cuota emparejada en ambas casas para medir discrepancia.",
    };
  }

  const oddsGap = round(retailOdd - sharpOdd, 2);
  if (oddsGap >= 0.15) {
    return {
      oddsGap,
      gapTier: "clear-retail-value",
      valueBook: DEFAULT_RETAIL_BOOK,
      valueOdd: retailOdd,
      confidenceBoost: 4,
      label: "Valor claro en Winamax",
      summary: `Winamax paga ${retailOdd.toFixed(2)} frente a ${sharpOdd.toFixed(2)} de Bet365.`,
    };
  }

  if (oddsGap >= 0.1) {
    return {
      oddsGap,
      gapTier: "retail-value",
      valueBook: DEFAULT_RETAIL_BOOK,
      valueOdd: retailOdd,
      confidenceBoost: 2,
      label: "Leve valor en Winamax",
      summary: `Winamax mejora el precio en +${oddsGap.toFixed(2)} frente a Bet365.`,
    };
  }

  if (oddsGap <= -0.1) {
    return {
      oddsGap,
      gapTier: "sharp-value",
      valueBook: DEFAULT_SHARP_BOOK,
      valueOdd: sharpOdd,
      confidenceBoost: 1,
      label: "Bet365 con valor",
      summary: `Bet365 ofrece ${sharpOdd.toFixed(2)} y Winamax esta ${Math.abs(oddsGap).toFixed(2)} por debajo.`,
    };
  }

  return {
    oddsGap,
    gapTier: "agreement",
    valueBook: retailOdd >= sharpOdd ? DEFAULT_RETAIL_BOOK : DEFAULT_SHARP_BOOK,
    valueOdd: retailOdd >= sharpOdd ? retailOdd : sharpOdd,
    confidenceBoost: 0,
    label: "Mercado de acuerdo",
    summary: "Bet365 y Winamax estan practicamente alineadas en este mercado.",
  };
}

export function buildOddsGapFactor(comparison) {
  const signal = buildGapSignal(comparison?.sharpOdd, comparison?.retailOdd);
  const score =
    signal.gapTier === "clear-retail-value"
      ? 20
      : signal.gapTier === "retail-value"
        ? 12
        : signal.gapTier === "sharp-value"
          ? 10
          : 0;

  return {
    key: "odds-gap",
    label: "Discrepancia Bet365 vs Winamax",
    score,
    weight: 7,
    confidenceBoost: signal.confidenceBoost,
    oddsGap: signal.oddsGap,
    valueBook: signal.valueBook,
    valueOdd: signal.valueOdd,
    tier: signal.gapTier,
    summary: signal.summary,
    shortLabel: signal.label,
  };
}

export function buildOddsComparison(bookmakers = {}, spec) {
  const winamaxKey = findWinamaxBookmakerKey(bookmakers);
  const sharpKey = findPreferredBookmakerKey(bookmakers, DEFAULT_SHARP_BOOK);
  const retailKey = findPreferredBookmakerKey(bookmakers, DEFAULT_RETAIL_BOOK) || winamaxKey;
  const candidates = [];

  for (const [bookmaker] of Object.entries(bookmakers)) {
    const odd =
      spec.sport === "mlb"
        ? extractMlbOdd(bookmakers, bookmaker, spec.type, spec.side, spec.line)
        : extractTennisOdd(bookmakers, bookmaker, spec.market, spec.selectionIndex);

    if (Number.isFinite(odd)) {
      candidates.push({ bookmaker, odd });
    }
  }

  const best = pickBestOdd(candidates);
  const winamaxOdd =
    spec.sport === "mlb"
      ? extractMlbOdd(bookmakers, winamaxKey, spec.type, spec.side, spec.line)
      : extractTennisOdd(bookmakers, winamaxKey, spec.market, spec.selectionIndex);
  const sharpOdd =
    spec.sport === "mlb"
      ? extractMlbOdd(bookmakers, sharpKey, spec.type, spec.side, spec.line)
      : extractTennisOdd(bookmakers, sharpKey, spec.market, spec.selectionIndex);
  const retailOdd =
    spec.sport === "mlb"
      ? extractMlbOdd(bookmakers, retailKey, spec.type, spec.side, spec.line)
      : extractTennisOdd(bookmakers, retailKey, spec.market, spec.selectionIndex);
  const gapSignal = buildGapSignal(sharpOdd, retailOdd);

  let comparisonNote = "Sin cuotas para comparar";
  if (!Number.isFinite(sharpOdd) && !Number.isFinite(retailOdd)) {
    comparisonNote = best?.bookmaker
      ? `Solo hay precio en ${displayBookmakerName(best.bookmaker)} (${best.odd.toFixed(2)}).`
      : "No hay cuotas suficientes para comparar este mercado.";
  } else if (!Number.isFinite(retailOdd)) {
    comparisonNote = best?.bookmaker
      ? `${DEFAULT_RETAIL_BOOK} no tiene este mercado; mejor precio en ${displayBookmakerName(best.bookmaker)} ${best.odd.toFixed(2)}`
      : `${DEFAULT_RETAIL_BOOK} y otras casas sin cuota en este pick`;
  } else if (!Number.isFinite(sharpOdd)) {
    comparisonNote = `${DEFAULT_SHARP_BOOK} no tiene este mercado; ${DEFAULT_RETAIL_BOOK} paga ${retailOdd.toFixed(2)}.`;
  } else if (!best?.odd) {
    comparisonNote = `Solo ${DEFAULT_RETAIL_BOOK} disponible: ${retailOdd.toFixed(2)}`;
  } else {
    comparisonNote = gapSignal.summary;
  }

  return {
    bestBookmaker: displayBookmakerName(best?.bookmaker) || null,
    bestBookmakerKey: best?.bookmaker || null,
    bestOdd: best?.odd ?? null,
    winamaxOdd: Number.isFinite(winamaxOdd) ? winamaxOdd : null,
    winamaxBetter: Number.isFinite(winamaxOdd) && Number.isFinite(sharpOdd) ? winamaxOdd > sharpOdd : false,
    sharpBook: sharpKey ? displayBookmakerName(sharpKey) : DEFAULT_SHARP_BOOK,
    sharpOdd: Number.isFinite(sharpOdd) ? sharpOdd : null,
    retailBook: retailKey ? displayBookmakerName(retailKey) : DEFAULT_RETAIL_BOOK,
    retailOdd: Number.isFinite(retailOdd) ? retailOdd : null,
    oddsGap: gapSignal.oddsGap,
    gapTier: gapSignal.gapTier,
    valueBook: gapSignal.valueBook,
    valueOdd: gapSignal.valueOdd,
    comparisonNote,
  };
}

