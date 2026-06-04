import {
  persistAnalyzerPicksFromMatches,
  mapFootballPickToBacktestRecord,
} from "./backtesting.js";
import { computeFootballInjuryImpact } from "./injury-impact.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { round, clamp } from "../utils/math.js";
import { canonicalName } from "../providers/shared/tennis-normalizers.js";
import {
  loadFootballValueBets,
  loadFootballDroppingOdds,
  loadFootballOddsMulti,
  loadFootballEvents,
  oddsApiSkipMarketSignals,
  getOddsApiMultiChunkSize,
} from "../providers/odds-api-io.js";
import { loadApiSportsFootballInsights } from "../providers/api-sports-football.js";
import { loadEspnSoccerInsights } from "../providers/espn-soccer.js";
import { getMadridTodayDateString } from "../utils/madrid-date.js";
import { filterBettableMatches, filterUpcomingDayMatches, isFutbolInSlateWindow } from "../utils/bettable-events.js";
import { calibrateForScoring, getMinRecommendationConfidence } from "./pick-calibration.js";
import { buildValueParlays } from "./parlay-builder.js";
import { getCachedOfficialQuinielaRows } from "./quiniela-official-cache.js";
import {
  filterPartidosExcludingQuiniela,
  filterPicksExcludingQuiniela,
  isQuinielaOfficialMatch,
} from "./quiniela-football-bridge.js";
import { enrichFootballPartidoWithPro } from "./football-odds-policy.js";

const _cfg = getRuntimeConfig().football;
const FOOTBALL_EV_MIN = _cfg.evThreshold;
const FOOTBALL_EV_YELLOW = 0.03;
const FOOTBALL_MIN_ODDS = _cfg.minOdds;
const FOOTBALL_MAX_ODDS = _cfg.maxOdds;
const FOOTBALL_MIN_CONF = _cfg.minConfidence;
const FOOTBALL_DROP_MIN = _cfg.dropMin;
const FOOTBALL_MAX_MATCH = _cfg.maxMatches;
const FOOTBALL_VERDE_CONF_MIN = Math.max(FOOTBALL_MIN_CONF, 62);
const FOOTBALL_AMARILLO_CONF_MIN = 50;
const FOOTBALL_EV_VERDE = Math.max(FOOTBALL_EV_MIN, 0.05);
const FOOTBALL_EV_AMARILLO = 0.03;
const FOOTBALL_DISPLAY_CONF_MIN = 52;
const _apiSportsCfg = getRuntimeConfig().apiSportsFootball;
const PICK_MODE = String(process.env.FOOTBALL_PICK_MODE || process.env.PICK_MODE || "value").toLowerCase();
const FOOTBALL_VALUE_EV_MIN = Number.parseFloat(process.env.FOOTBALL_VALUE_EV_MIN || "0.04");
const FOOTBALL_RECOMMENDATION_CONF_MIN = getMinRecommendationConfidence("football");
const FOOTBALL_VALUE_CONF_MIN = Math.max(
  Number.parseFloat(process.env.FOOTBALL_VALUE_CONF_MIN || "58"),
  FOOTBALL_RECOMMENDATION_CONF_MIN
);

function readFiniteNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.replace("%", "").replace("+", "").replace(",", ".").trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeEvNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Math.abs(value) > 1 ? value / 100 : value;
}

function footballPickEv(pick) {
  return normalizeEvNumber(readFiniteNumber(pick?.ev, pick?.ev_model, pick?.evRaw));
}

function footballPickConfidence(pick) {
  return readFiniteNumber(pick?.confidence, pick?.confianza, pick?.modelConfidence, pick?.confianza_final) ?? 0;
}

function footballPickScoreForRank(pick) {
  return readFiniteNumber(pick?.score_final, pick?.score, pick?.confidence, pick?.confianza, pick?.modelConfidence) ?? 0;
}

function footballPickOdds(pick) {
  const values = [pick?.mejor_cuota, pick?.bestOdds, pick?.odds, pick?.bet365_odds, pick?.winamax_odds]
    .map((value) => readFiniteNumber(value))
    .filter((value) => Number.isFinite(value) && value > 1);
  return values.length ? Math.max(...values) : null;
}

function footballPickEdge(pick) {
  return readFiniteNumber(pick?.edge);
}

function isFootballValueMode() {
  return PICK_MODE !== "pro" && PICK_MODE !== "strict";
}

function isFootballValuePick(pick) {
  if (!isFootballValueMode()) return false;
  const estado = String(pick?.estado || pick?.color || "").toLowerCase();
  if (estado !== "amarillo" && estado !== "verde") return false;
  if (pick?.lineTrapActive) return false;

  const ev = footballPickEv(pick);
  const confidence = footballPickConfidence(pick);
  const odds = footballPickOdds(pick);
  if (!Number.isFinite(ev) || ev < FOOTBALL_VALUE_EV_MIN) return false;
  if (!Number.isFinite(confidence) || confidence < FOOTBALL_VALUE_CONF_MIN) return false;
  if (!Number.isFinite(odds) || odds < FOOTBALL_MIN_ODDS || odds > FOOTBALL_MAX_ODDS) return false;

  const failures = Array.isArray(pick?.value_gates?.failures) ? pick.value_gates.failures : [];
  return !failures.some((failure) => ["cuota_fuera_rango", "ev_bajo", "rlm_contra"].includes(failure));
}

function footballValueRankScore(pick) {
  const ev = footballPickEv(pick) ?? -1;
  const confidence = footballPickConfidence(pick) / 100;
  const score = footballPickScoreForRank(pick) / 100;
  const edge = Math.abs(footballPickEdge(pick) ?? 0);
  const stateBoost = pick?.estado === "verde" ? 0.12 : isFootballValuePick(pick) ? 0.08 : 0;
  const signalBoost = pick?.senalDoble ? 0.03 : 0;
  return ev * 1.8 + score * 0.7 + confidence * 0.45 + edge * 0.6 + stateBoost + signalBoost;
}

function compareFootballPicksForValue(left, right) {
  const rankDiff = footballValueRankScore(right) - footballValueRankScore(left);
  if (Math.abs(rankDiff) > 0.0001) return rankDiff;
  const evDiff = (footballPickEv(right) ?? -99) - (footballPickEv(left) ?? -99);
  if (Math.abs(evDiff) > 0.0001) return evDiff;
  const confidenceDiff = footballPickConfidence(right) - footballPickConfidence(left);
  if (confidenceDiff !== 0) return confidenceDiff;
  return (footballPickOdds(right) ?? 0) - (footballPickOdds(left) ?? 0);
}

const MERCADOS = [
  "Totals",
  "Totals HT",
  "ML",
  "Double Chance",
  "Spread HT",
  "Corners Totals",
  "Corners Totals HT",
  "Bookings Totals",
  "Team Total Home",
  "Team Total Away",
  "Spread",
  "Corners Spread",
  "Bookings Spread",
];

// Tier 1: UEFA + World competitions (highest priority)
const TIER1_LEAGUES = [
  "europe-uefa-champions-league",
  "europe-uefa-europa-league",
  "europe-uefa-conference-league",
  "europe-uefa-nations-league",
  "uefa-champions-league",
  "uefa-europa-league",
  "uefa-conference-league",
  "uefa-nations-league",
  "champions-league",
  "europa-league",
  "conference-league",
  "nations-league",
  "world-cup",
  "fifa-world-cup",
  "world-cup-qualification",
  "copa-mundial",
  "euro",
  "uefa-euro",
  "copa-america",
  "concacaf",
  "africa-cup",
];

// Tier 2: Big 5 domestic leagues
const TIER2_LEAGUES = [
  "spain-laliga",
  "england-premier-league",
  "germany-bundesliga",
  "italy-serie-a",
  "france-ligue-1",
  "laliga",
  "premier-league",
  "bundesliga",
  "serie-a",
  "ligue-1",
];

// Tier 3: Major cups + other top domestic leagues
const TIER3_LEAGUES = [
  "spain-copa-del-rey",
  "copa-del-rey",
  "england-fa-cup",
  "fa-cup",
  "england-efl-cup",
  "league-cup",
  "germany-dfb-pokal",
  "dfb-pokal",
  "italy-coppa-italia",
  "coppa-italia",
  "france-coupe-de-france",
  "coupe-de-france",
  "netherlands-eredivisie",
  "eredivisie",
  "portugal-primeira-liga",
  "primeira-liga",
  "liga-nos",
  "turkey-super-lig",
  "super-lig",
  "belgium-first-division",
  "jupiler",
  "scotland-premiership",
  "scottish-premiership",
  "russia-premier-league",
  "mexico-liga-mx",
  "liga-mx",
  "argentina-primera-division",
  "brazil-serie-a",
  "mls",
];

// Exclude youth/reserve/women competitions regardless of tier match.
// Senior international friendlies are allowed separately; club friendlies stay excluded.
const YOUTH_EXCLUSION_PATTERNS = /\bu(17|18|19|20|21|23)\b|youth|junior|reserve|reserves|sub-17|sub-20|sub-21|sub-23|women|ladies|femenin/i;
const FRIENDLY_PATTERN = /\b(friendl(?:y|ies)|amistos(?:o|os|a|as))\b/i;
const INTERNATIONAL_PATTERN = /\b(international|internationals|intl|world|fifa|national|nations|internacional|selecciones?)\b/i;
const CLUB_FRIENDLY_LEAGUE_PATTERN = /\b(club|clubs|preseason|pre-season)\b/i;
const CLUB_FRIENDLY_TEAM_PATTERN = /\b(fc|cf|afc|sc|ac|as|cd|ud|club|reserves?|ii|b)\b/i;
const WOMEN_SHORT_MARKER_PATTERN = /(?:^|[\s([._-])W(?:$|[\s)\].,_-])|(?:^|[\s._-])w(?:$|[\s._-])/;

function hasWomenMarker(...values) {
  return values.some((value) => WOMEN_SHORT_MARKER_PATTERN.test(String(value || "")));
}

function isYouthOrExcludedEvent(evento) {
  const leagueName = String(evento?.league?.name || evento?.league || "");
  const leagueSlug = String(evento?.league?.slug || "");
  const homeName = String(evento?.home || evento?.homeTeam?.name || "");
  const awayName = String(evento?.away || evento?.awayTeam?.name || "");
  return (
    YOUTH_EXCLUSION_PATTERNS.test(leagueName) ||
    YOUTH_EXCLUSION_PATTERNS.test(leagueSlug) ||
    YOUTH_EXCLUSION_PATTERNS.test(homeName) ||
    YOUTH_EXCLUSION_PATTERNS.test(awayName) ||
    hasWomenMarker(leagueName, leagueSlug, homeName, awayName)
  );
}

function hasRealDataForPick(ctx) {
  if (!ctx) return false;
  const source = String(ctx.__source || ctx.source || "").toLowerCase();
  if (source === "priors") return false;
  if (source.includes("espn")) return true;
  const hasForm =
    (Array.isArray(ctx.forma) && ctx.forma.length > 0) ||
    (Array.isArray(ctx.home_recent_matches) && ctx.home_recent_matches.length > 0) ||
    (Array.isArray(ctx.away_recent_matches) && ctx.away_recent_matches.length > 0);
  const hasPoisson = Number.isFinite(ctx.model_home_prob) && Number.isFinite(ctx.model_away_prob);
  const hasExpectedGoals = Number.isFinite(ctx.expected_goals) && ctx.expected_goals > 0;
  const hasApiPrediction = Boolean(ctx.api_sports_has_predictions) || hasPoisson || hasExpectedGoals;
  if (source.includes("api-sports")) return hasApiPrediction;
  const hasGoals =
    Number.isFinite(ctx.home_goals_for) &&
    ctx.home_goals_for > 0 &&
    Number.isFinite(ctx.away_goals_for) &&
    ctx.away_goals_for > 0;
  return hasForm || hasGoals || hasPoisson || hasExpectedGoals;
}

function isSeniorInternationalFriendly(evento) {
  const leagueName = String(evento?.league?.name || evento?.league || "");
  const leagueSlug = String(evento?.league?.slug || "");
  const homeName = String(evento?.home || evento?.homeTeam?.name || "");
  const awayName = String(evento?.away || evento?.awayTeam?.name || "");
  const leagueText = `${leagueName} ${leagueSlug}`;

  if (!FRIENDLY_PATTERN.test(leagueText) || !INTERNATIONAL_PATTERN.test(leagueText)) return false;
  if (CLUB_FRIENDLY_LEAGUE_PATTERN.test(leagueText)) return false;
  if (
    YOUTH_EXCLUSION_PATTERNS.test(leagueText) ||
    YOUTH_EXCLUSION_PATTERNS.test(homeName) ||
    YOUTH_EXCLUSION_PATTERNS.test(awayName) ||
    hasWomenMarker(leagueText, homeName, awayName)
  ) {
    return false;
  }
  if (CLUB_FRIENDLY_TEAM_PATTERN.test(homeName) || CLUB_FRIENDLY_TEAM_PATTERN.test(awayName)) {
    return false;
  }
  return true;
}

function normalizeExpectedValue(value) {
  if (!Number.isFinite(value)) return 0;
  let ev = Number(value);

  // Odds-API.io has emitted EV in three formats across endpoints/docs:
  // decimal (0.052), percentage points (5.2) and return-index (105.2 => +5.2% EV).
  if (Math.abs(ev) > 50) {
    ev = ev > 0 ? (ev - 100) / 100 : (ev + 100) / 100;
  } else if (Math.abs(ev) > 1) {
    ev = ev / 100;
  }

  if (ev > 0.5 || ev < -0.5) return 0;
  return calibrateForScoring(ev) ?? 0;
}

function isBookingsMarket(mercado) {
  return mercado === "Bookings Totals" || mercado === "Bookings Spread";
}

function hasRefereeInfo(insight) {
  const referee = String(insight?.referee || "").trim();
  return Boolean(referee);
}

function averageFinite(...values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function poissonPmfSimple(k, lambda) {
  if (k < 0 || !Number.isFinite(lambda) || lambda <= 0) return 0;
  let probability = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) {
    probability *= lambda / i;
  }
  return probability;
}

function estimatePoissonOverProb(lambdaHome, lambdaAway, line = 2.5) {
  const lambda = Number(lambdaHome) + Number(lambdaAway);
  const threshold = Math.floor(Number(line));
  if (!Number.isFinite(lambda) || lambda <= 0 || !Number.isFinite(threshold) || threshold < 0) return null;

  let underOrPush = 0;
  for (let goals = 0; goals <= threshold; goals += 1) {
    underOrPush += poissonPmfSimple(goals, lambda);
  }
  return clamp(1 - underOrPush, 0.01, 0.99);
}

function recentResultCode(entry) {
  const value = typeof entry === "string" ? entry : entry?.result;
  const normalized = String(value || "").toUpperCase();
  return normalized === "W" || normalized === "D" || normalized === "L" ? normalized : null;
}

function recentMatchesForFocus(ctx = {}) {
  if (ctx.teamFocus === "home" && Array.isArray(ctx.home_recent_matches)) return ctx.home_recent_matches;
  if (ctx.teamFocus === "away" && Array.isArray(ctx.away_recent_matches)) return ctx.away_recent_matches;
  if (Array.isArray(ctx.forma)) return ctx.forma.map((result) => ({ result }));
  return [];
}

function weightedRecentFormRatio(matches = []) {
  const usable = matches.slice(0, 6).map(recentResultCode).filter(Boolean);
  if (!usable.length) return null;

  let weightedPoints = 0;
  let maxWeightedPoints = 0;
  usable.forEach((result, index) => {
    const weight = 0.8 ** index;
    weightedPoints += weight * (result === "W" ? 3 : result === "D" ? 1 : 0);
    maxWeightedPoints += weight * 3;
  });

  return maxWeightedPoints > 0 ? weightedPoints / maxWeightedPoints : null;
}

function attackVsDefenseMetric(attackGoals, rivalGoalsAgainst, attackStrength, rivalDefenceStrength) {
  let base = averageFinite(attackGoals, rivalGoalsAgainst) ?? attackGoals ?? 0;
  if (Number.isFinite(attackStrength)) {
    base += (attackStrength - 0.5) * 0.7;
  }
  if (Number.isFinite(rivalDefenceStrength)) {
    base += (0.5 - rivalDefenceStrength) * 0.45;
  }
  return Math.max(0.25, base);
}

function apiSportsUnderOverAligns(ctx, betSide) {
  const signal = ctx?.api_sports_under_over || ctx?.model_under_over || null;
  const side = String(signal?.side || "").toLowerCase();
  if (!side || !betSide) return false;
  return side === String(betSide).toLowerCase();
}

function buildFootballMarketContextScore(mercado, ctx, betSide = null) {
  const homeGoalsFor = readFiniteNumber(ctx?.home_goals_for, ctx?.goles_favor_local) ?? 0;
  const awayGoalsFor = readFiniteNumber(ctx?.away_goals_for, ctx?.goles_favor_away) ?? 0;
  const homeGoalsAgainst = readFiniteNumber(ctx?.home_goals_against, ctx?.home_season_goals_against);
  const awayGoalsAgainst = readFiniteNumber(ctx?.away_goals_against, ctx?.away_season_goals_against);
  const homeVsRival = attackVsDefenseMetric(
    homeGoalsFor,
    awayGoalsAgainst,
    readFiniteNumber(ctx?.home_attack_strength, ctx?.model_home_attack_strength),
    readFiniteNumber(ctx?.away_defence_strength, ctx?.model_away_defence_strength)
  );
  const awayVsRival = attackVsDefenseMetric(
    awayGoalsFor,
    homeGoalsAgainst,
    readFiniteNumber(ctx?.away_attack_strength, ctx?.model_away_attack_strength),
    readFiniteNumber(ctx?.home_defence_strength, ctx?.model_home_defence_strength)
  );
  const focusedGoals =
    ctx?.teamFocus === "home"
      ? homeVsRival
      : ctx?.teamFocus === "away"
        ? awayVsRival
        : averageFinite(homeVsRival, awayVsRival) ?? 0;
  const expectedGoals = ctx?.expected_goals ?? averageFinite(homeVsRival, awayVsRival) ?? 0;
  const expectedCorners = ctx?.expected_corners_total ?? averageFinite(ctx?.home_corners_for, ctx?.away_corners_for) ?? null;
  const expectedCards = ctx?.expected_cards_total ?? averageFinite(ctx?.home_cards_for, ctx?.away_cards_for) ?? null;
  const combinedBtts = averageFinite(ctx?.home_btts_rate, ctx?.away_btts_rate, ctx?.h2h_btts_rate, ctx?.model_btts_rate);
  const combinedOver25 = averageFinite(ctx?.home_over25_rate, ctx?.away_over25_rate, ctx?.h2h_over25_rate);
  const homeShotsOnTarget = readFiniteNumber(ctx?.home_shots_on_target);
  const awayShotsOnTarget = readFiniteNumber(ctx?.away_shots_on_target);
  const totalShotsOnTarget = averageFinite(homeShotsOnTarget, awayShotsOnTarget) != null
    ? (homeShotsOnTarget || 0) + (awayShotsOnTarget || 0)
    : null;
  const isFirstHalf = String(mercado).includes("HT");
  const goalsReference = isFirstHalf ? expectedGoals * 0.46 : expectedGoals;
  const cornersReference = Number.isFinite(expectedCorners) ? expectedCorners * (isFirstHalf ? 0.48 : 1) : null;
  const cardsReference = Number.isFinite(expectedCards) ? expectedCards * (isFirstHalf ? 0.52 : 1) : null;

  if (mercado === "Totals" || mercado === "Totals HT") {
    const poissonOverProb = mercado === "Totals"
      ? estimatePoissonOverProb(ctx?.lambda_home, ctx?.lambda_away, 2.5)
      : null;
    let score;

    if (Number.isFinite(poissonOverProb)) {
      const modelProb = betSide === "under" ? 1 - poissonOverProb : poissonOverProb;
      score = modelProb >= 0.67 ? 8 : modelProb >= 0.58 ? 6 : modelProb >= 0.5 ? 4 : 1;
    } else {
      score = goalsReference >= 3.3 ? 8 : goalsReference >= 2.8 ? 6 : goalsReference >= 2.2 ? 4 : 1;
      if (mercado === "Totals HT") {
        score = goalsReference >= 1.65 ? 8 : goalsReference >= 1.45 ? 6 : goalsReference >= 1.15 ? 4 : 1;
      }
    }

    if (betSide === "over") {
      if (Number.isFinite(combinedBtts) && combinedBtts >= 0.55) score = Math.min(score + 1, 8);
      if (Number.isFinite(combinedOver25) && combinedOver25 >= 0.60) score = Math.min(score + 1, 8);
      if (Number.isFinite(totalShotsOnTarget) && totalShotsOnTarget >= 8.5) score = Math.min(score + 1, 8);
    }
    if (betSide === "under" && Number.isFinite(combinedOver25) && combinedOver25 <= 0.30) {
      score = Math.min(score + 1, 8);
    }

    const h2hRate = ctx?.h2h_over25_rate;
    if (Number.isFinite(h2hRate)) {
      if (betSide === "over" && h2hRate >= 0.60) score = Math.min(score + 1, 8);
      if (betSide === "under" && h2hRate <= 0.35) score = Math.min(score + 1, 8);
    }
    if (apiSportsUnderOverAligns(ctx, betSide)) score = Math.min(score + 1, 8);
    return score;
  }

  if (mercado === "Team Total Home" || mercado === "Team Total Away") {
    const attackVsDefense = mercado === "Team Total Home" ? homeVsRival : awayVsRival;
    if (betSide === "under") {
      if (attackVsDefense <= 0.85) return 8;
      if (attackVsDefense <= 1.05) return 6;
      if (attackVsDefense <= 1.30) return 4;
      return 1;
    }
    if (attackVsDefense >= 2.0) return 8;
    if (attackVsDefense >= 1.6) return 6;
    if (attackVsDefense >= 1.2) return 4;
    return 1;
  }

  if (mercado === "Corners Totals" || mercado === "Corners Spread" || mercado === "Corners Totals HT") {
    if (mercado === "Corners Totals HT") {
      if (cornersReference >= 5.5) return 8;
      if (cornersReference >= 4.8) return 6;
      if (cornersReference >= 4.0) return 4;
      return 1;
    }
    if (cornersReference >= 10.5) return 8;
    if (cornersReference >= 9.2) return 6;
    if (cornersReference >= 8.1) return 4;
    return 1;
  }

  if (mercado === "Bookings Totals" || mercado === "Bookings Spread") {
    if (cardsReference >= 5.8) return 8;
    if (cardsReference >= 4.8) return 6;
    if (cardsReference >= 3.8) return 4;
    return 1;
  }

  if (mercado === "ML" || mercado === "Spread" || mercado === "Spread HT") {
    if (focusedGoals >= 2.1) return 8;
    if (focusedGoals >= 1.6) return 6;
    if (focusedGoals >= 1.2) return 4;
    return 2;
  }

  if (mercado === "Double Chance") {
    if (focusedGoals >= 1.8) return 6;
    if (focusedGoals >= 1.3) return 4;
    return 2;
  }

  return 2;
}

function resolveFootballBookOdds(odds, mercado, betSide) {
  const books = odds || {};
  const readBook = (name) => {
    if (!books || typeof books !== "object") return {};
    const candidates = [name, String(name), String(name).toLowerCase(), canonicalName(name)].filter(Boolean);
    for (const key of candidates) {
      if (books[key]) return books[key];
    }
    const desired = canonicalName(name);
    for (const [key, book] of Object.entries(books)) {
      if (canonicalName(key) === desired) return book || {};
    }
    return {};
  };
  const bet365Book = readBook("Bet365");
  const winamaxBook = readBook("Winamax FR") || readBook("Winamax");
  const b365 = Number.parseFloat(bet365Book?.[mercado]?.[betSide] || 0);
  const wmx = Number.parseFloat(winamaxBook?.[mercado]?.[betSide] || 0);
  return { b365, wmx };
}

function pickBestMlOdds(odds, side) {
  let best = null;
  const readBook = (name) => {
    if (!odds || typeof odds !== "object") return {};
    const candidates = [name, String(name), String(name).toLowerCase(), canonicalName(name)].filter(Boolean);
    for (const key of candidates) {
      if (odds[key]) return odds[key];
    }
    const desired = canonicalName(name);
    for (const [key, book] of Object.entries(odds)) {
      if (canonicalName(key) === desired) return book || {};
    }
    return {};
  };
  for (const book of ["Bet365", "Winamax FR", "bet365", "Winamax"]) {
    const value = Number.parseFloat(readBook(book)?.ML?.[side] || 0);
    if (Number.isFinite(value) && value > 1 && (!best || value > best.odds)) {
      best = { odds: value, book };
    }
  }
  return best;
}

function extractMlOddsSnapshot(odds) {
  if (!odds || typeof odds !== "object") return null;
  const home = pickBestMlOdds(odds, "home");
  const draw = pickBestMlOdds(odds, "draw");
  const away = pickBestMlOdds(odds, "away");
  if (!home && !draw && !away) return null;
  return {
    home: home?.odds ?? null,
    draw: draw?.odds ?? null,
    away: away?.odds ?? null,
    books: [...new Set([home?.book, draw?.book, away?.book].filter(Boolean))],
  };
}

function extractFootballCtxSnapshot(baseCtx = {}) {
  const injuries = Array.isArray(baseCtx.lesiones)
    ? baseCtx.lesiones.filter((entry) => ["out", "doubtful"].includes(entry?.status)).length
    : 0;
  const arr = (value) => (Array.isArray(value) ? value : []);
  return {
    source: baseCtx.__source || "priors",
    lambda_home: baseCtx.lambda_home ?? null,
    lambda_away: baseCtx.lambda_away ?? null,
    model_home_prob: baseCtx.model_home_prob ?? null,
    model_draw_prob: baseCtx.model_draw_prob ?? null,
    model_away_prob: baseCtx.model_away_prob ?? null,
    expected_goals: baseCtx.expected_goals ?? null,
    model_goals_home: baseCtx.model_goals_home ?? null,
    model_goals_away: baseCtx.model_goals_away ?? null,
    home_goals_for: baseCtx.home_goals_for ?? null,
    away_goals_for: baseCtx.away_goals_for ?? null,
    home_goals_against: baseCtx.home_goals_against ?? null,
    away_goals_against: baseCtx.away_goals_against ?? null,
    goles_favor_local: baseCtx.goles_favor_local ?? null,
    goles_favor_away: baseCtx.goles_favor_away ?? null,
    forma: arr(baseCtx.forma),
    home_forma: arr(baseCtx.home_forma),
    away_forma: arr(baseCtx.away_forma),
    home_recent_matches: arr(baseCtx.home_recent_matches),
    away_recent_matches: arr(baseCtx.away_recent_matches),
    home_win_rate: baseCtx.home_win_rate ?? null,
    away_win_rate: baseCtx.away_win_rate ?? null,
    home_win_rate_home: baseCtx.home_win_rate_home ?? null,
    away_win_rate_away: baseCtx.away_win_rate_away ?? null,
    home_attack_strength: baseCtx.home_attack_strength ?? baseCtx.model_home_attack_strength ?? null,
    away_attack_strength: baseCtx.away_attack_strength ?? baseCtx.model_away_attack_strength ?? null,
    home_defence_strength: baseCtx.home_defence_strength ?? baseCtx.model_home_defence_strength ?? null,
    away_defence_strength: baseCtx.away_defence_strength ?? baseCtx.model_away_defence_strength ?? null,
    home_btts_rate: baseCtx.home_btts_rate ?? null,
    away_btts_rate: baseCtx.away_btts_rate ?? null,
    model_btts_rate: baseCtx.model_btts_rate ?? null,
    home_over25_rate: baseCtx.home_over25_rate ?? null,
    away_over25_rate: baseCtx.away_over25_rate ?? null,
    h2h_home_win_rate: baseCtx.h2h_home_win_rate ?? baseCtx.model_h2h_home_rate ?? null,
    h2h_draw_rate: baseCtx.h2h_draw_rate ?? baseCtx.model_h2h_draw_rate ?? null,
    h2h_away_win_rate: baseCtx.h2h_away_win_rate ?? baseCtx.model_h2h_away_rate ?? null,
    h2h_over25_rate: baseCtx.h2h_over25_rate ?? null,
    h2h_btts_rate: baseCtx.h2h_btts_rate ?? null,
    h2h_avg_goals: baseCtx.h2h_avg_goals ?? null,
    h2h_market_label: baseCtx.h2h_market_label || null,
    expected_corners_total: baseCtx.expected_corners_total ?? null,
    expected_cards_total: baseCtx.expected_cards_total ?? null,
    home_corners_for: baseCtx.home_corners_for ?? null,
    away_corners_for: baseCtx.away_corners_for ?? null,
    home_corners_against: baseCtx.home_corners_against ?? null,
    away_corners_against: baseCtx.away_corners_against ?? null,
    home_cards_for: baseCtx.home_cards_for ?? null,
    away_cards_for: baseCtx.away_cards_for ?? null,
    home_cards_against: baseCtx.home_cards_against ?? null,
    away_cards_against: baseCtx.away_cards_against ?? null,
    home_shots_on_target: baseCtx.home_shots_on_target ?? null,
    away_shots_on_target: baseCtx.away_shots_on_target ?? null,
    api_sports_under_over: baseCtx.api_sports_under_over ?? baseCtx.model_under_over ?? null,
    api_sports_has_predictions: Boolean(baseCtx.api_sports_has_predictions),
    posicion: baseCtx.posicion ?? null,
    home_posicion: baseCtx.home_posicion ?? null,
    away_posicion: baseCtx.away_posicion ?? null,
    total_equipos: baseCtx.total_equipos ?? null,
    home_season_ppg: baseCtx.home_season_ppg ?? null,
    away_season_ppg: baseCtx.away_season_ppg ?? null,
    home_season_goals_against: baseCtx.home_season_goals_against ?? null,
    away_season_goals_against: baseCtx.away_season_goals_against ?? null,
    home_venue_advantage: baseCtx.home_venue_advantage ?? null,
    home_gamma: baseCtx.home_gamma ?? null,
    esTopLeague: Boolean(baseCtx.esTopLeague),
    home_lineup_confirmed: Boolean(baseCtx.home_lineup_confirmed),
    away_lineup_confirmed: Boolean(baseCtx.away_lineup_confirmed),
    lineup_confirmed: Boolean(baseCtx.lineup_confirmed),
    injuries,
  };
}

function buildFootballModelLeanFromOdds(evento, odds, baseCtx, insight) {
  const mercadoCandidates = [
    { mercado: "ML", sides: ["home", "away"] },
    { mercado: "Double Chance", sides: ["1X", "X2"] },
    { mercado: "Totals", sides: ["over", "under"] },
  ];
  const picks = [];
  const sin_valor = [];

  for (const { mercado, sides } of mercadoCandidates) {
    for (const betSide of sides) {
      const { b365, wmx } = resolveFootballBookOdds(odds, mercado, betSide);
      const bestAvail = Math.max(b365 || 0, wmx || 0);
      if (!Number.isFinite(bestAvail) || bestAvail <= 1) continue;

      const ctx = resolveFootballContext(baseCtx, mercado, betSide);
      const scBase = calcularScorePick({ ev: 0, drop12h: 0, dropBetSide: null, bet365: b365, winamax: wmx, mercado, betSide, ctx, nextMatchDate: evento.date });
      const impliedProb = 1 / bestAvail;

      // Usar probabilidades Poisson de API-Sports cuando están disponibles
      let modelProb;
      const mHome = baseCtx.model_home_prob;
      const mDraw = baseCtx.model_draw_prob;
      const mAway = baseCtx.model_away_prob;
      const mGoalsTotal = (baseCtx.model_goals_home ?? 0) + (baseCtx.model_goals_away ?? 0);
      const has1x2Model = Number.isFinite(mHome) && Number.isFinite(mDraw) && Number.isFinite(mAway);

      if (mercado === "ML" && !isPickSideCoherentWithModel(betSide, mHome, mDraw, mAway)) {
        continue;
      }

      if (mercado === "ML" && betSide === "home" && Number.isFinite(mHome)) {
        modelProb = mHome;
      } else if (mercado === "ML" && betSide === "away" && Number.isFinite(mAway)) {
        modelProb = mAway;
      } else if (mercado === "ML" && betSide === "draw" && Number.isFinite(mDraw)) {
        modelProb = mDraw;
      } else if (mercado === "Double Chance" && betSide === "1X" && Number.isFinite(mHome) && Number.isFinite(mDraw)) {
        modelProb = clamp(mHome + mDraw, 0.3, 0.97);
      } else if (mercado === "Double Chance" && betSide === "X2" && Number.isFinite(mDraw) && Number.isFinite(mAway)) {
        modelProb = clamp(mDraw + mAway, 0.3, 0.97);
      } else if (mercado === "Totals" && mGoalsTotal > 0) {
        const books = odds || {};
        const rawHdp =
          books?.Bet365?.["Totals"]?.hdp ??
          books?.["Winamax FR"]?.["Totals"]?.hdp ??
          books?.bet365?.["Totals"]?.hdp ??
          null;
        const goalLine = Number.isFinite(Number(rawHdp)) && Number(rawHdp) > 0 ? Number(rawHdp) : 2.5;
        modelProb = betSide === "over"
          ? clamp(mGoalsTotal / (goalLine + mGoalsTotal), 0.25, 0.88)
          : clamp(goalLine / (goalLine + mGoalsTotal), 0.25, 0.88);
      } else {
        if ((mercado === "ML" || mercado === "Double Chance") && !has1x2Model) continue;
        if (mercado === "Totals" && !Number.isFinite(baseCtx?.expected_goals)) continue;
        // Sin predicciones: ajuste contextual sobre probabilidad implícita
        const contextAdjustment = (scBase.total - 50) / 200;
        modelProb = clamp(impliedProb + contextAdjustment, 0.25, 0.88);
      }

      const modelEv = round(modelProb * bestAvail - 1, 3);
      if (modelEv <= 0) continue;

      const sc = calcularScorePick({ ev: modelEv, drop12h: 0, dropBetSide: null, bet365: b365, winamax: wmx, mercado, betSide, ctx, nextMatchDate: evento.date });
      const pick = {
        mercado, linea: null, betSide,
        seleccion: formatFootballSelection(mercado, betSide, null, evento),
        bookSearchLabel: formatFootballBookSearchLabel(mercado, betSide, null, evento),
        ev: modelEv, evPercent: `+${(modelEv * 100).toFixed(1)}%`,
        confianza: sc.total, modelConfidence: sc.total, scores: sc.scores,
        bet365_odds: sc.bet365Odds, winamax_odds: sc.winamaxOdds,
        mejor_cuota: sc.bestOdds, valueBook: sc.valueBook, gap: sc.gap,
        drop_12h: 0, senalDoble: false,
        rationale: buildFootballPickNarrative(mercado, evento, ctx, `+${(modelEv * 100).toFixed(1)}%`, sc.total),
        supportLabel: buildFootballSupportLabel(ctx, mercado),
        source: baseCtx.__source || "priors",
        href: null, modelOnly: true,
      };

      if (esVerde(modelEv, sc.bestOdds, sc.total, sc.bajasTitulares, false, mercado, ctx)) {
        picks.push({ ...pick, estado: "verde" });
      } else if (esAmarillo(modelEv, sc.bestOdds, sc.total, sc.bajasTitulares, false, mercado, ctx)) {
        picks.push({ ...pick, estado: "amarillo" });
      } else if (sc.total >= FOOTBALL_DISPLAY_CONF_MIN && hasRealDataForPick(ctx)) {
        sin_valor.push({ ...pick, estado: "modelo", bet365Odds: sc.bet365Odds, winamaxOdds: sc.winamaxOdds, bestOdds: sc.bestOdds, drop12h: 0 });
      }
    }
  }

  return { picks, sin_valor };
}

function isPickSideCoherentWithModel(betSide, mHome, mDraw, mAway) {
  if (!Number.isFinite(mHome) || !Number.isFinite(mAway)) return true;
  if (betSide === "home") return mHome > mAway && mHome > mDraw;
  if (betSide === "away") return mAway > mHome && mAway > mDraw;
  if (betSide === "draw") return mDraw > mHome && mDraw > mAway;
  return true;
}

function computeRestDays(recentMatches, nextMatchDate) {
  if (!Array.isArray(recentMatches) || !recentMatches.length || !nextMatchDate) return null;
  const lastGameDate = recentMatches[0]?.gameDate;
  if (!lastGameDate) return null;
  const diff = (new Date(nextMatchDate) - new Date(lastGameDate)) / 86400000;
  return Number.isFinite(diff) && diff >= 0 ? Math.round(diff) : null;
}

function calcularScorePick({ ev, drop12h, dropBetSide, bet365, winamax, mercado, betSide, ctx, nextMatchDate }) {
  const bestOdds = Math.max(bet365 || 0, winamax || 0);
  const gap = (winamax || 0) - (bet365 || 0);

  const A = ev >= 0.15 ? 20 : ev >= 0.1 ? 16 : ev >= 0.07 ? 12 : ev >= 0.05 ? 8 : ev >= 0.03 ? 3 : 0;

  let B = drop12h >= 20 ? 15 : drop12h >= 15 ? 12 : drop12h >= 10 ? 8 : drop12h >= 5 ? 4 : 0;
  if (dropBetSide === betSide && drop12h >= 8) B = Math.min(B + 3, 15);

  const C =
    Math.abs(gap) >= 0.2 ? 10 : Math.abs(gap) >= 0.12 ? 8 : Math.abs(gap) >= 0.08 ? 6 : Math.abs(gap) < 0.03 ? 3 : 2;

  const D =
    bestOdds >= 1.55 && bestOdds <= 2.1
      ? 10
      : bestOdds >= 1.45 && bestOdds < 1.55
        ? 7
        : bestOdds > 2.1 && bestOdds <= 2.8
          ? 7
          : bestOdds > 2.8 && bestOdds <= 3.4
            ? 4
            : 0;

  const recentMatches = recentMatchesForFocus(ctx);
  const recentFormRatio = weightedRecentFormRatio(recentMatches);
  const hasFormData = Number.isFinite(recentFormRatio);
  // Sin datos de forma: prior neutro según nivel de liga. Con datos pobres: penalizar sin bonus de liga.
  const baselineE = hasFormData ? 1 : (ctx?.esTopLeague ? 2 : 1);
  const E = !hasFormData
    ? baselineE
    : recentFormRatio >= 0.75
      ? 8
      : recentFormRatio >= 0.58
        ? 6
        : recentFormRatio >= 0.40
          ? 4
          : baselineE;

  const F = buildFootballMarketContextScore(mercado, ctx, betSide);

  const homeWinRate = ctx?.home_win_rate_home ?? ctx?.home_win_rate ?? 0.5;
  const awayWinRate = ctx?.away_win_rate_away ?? ctx?.away_win_rate ?? 0.5;
  const rawTasa =
    ctx?.teamFocus === "home"
      ? homeWinRate
      : ctx?.teamFocus === "away"
        ? awayWinRate
        : (homeWinRate + awayWinRate) / 2;
  const hasPoissonModel =
    Number.isFinite(ctx?.model_home_prob) &&
    Number.isFinite(ctx?.model_draw_prob) &&
    Number.isFinite(ctx?.model_away_prob);
  // Con Poisson/Dixon-Coles activo no mezclar PPG (evita diluir el modelo xG)
  const seasonPpg =
    ctx?.teamFocus === "home" ? ctx?.home_season_ppg
    : ctx?.teamFocus === "away" ? ctx?.away_season_ppg
    : (Number.isFinite(ctx?.home_season_ppg) && Number.isFinite(ctx?.away_season_ppg))
      ? (ctx.home_season_ppg + ctx.away_season_ppg) / 2
      : null;
  let tasa = hasPoissonModel
    ? rawTasa
    : Number.isFinite(seasonPpg) && seasonPpg > 0
      ? rawTasa * 0.6 + clamp(seasonPpg / 3.0, 0.15, 0.85) * 0.4
      : rawTasa;
  if (!hasPoissonModel) {
    const focusedAttackStrength =
      ctx?.teamFocus === "home"
        ? readFiniteNumber(ctx?.home_attack_strength, ctx?.model_home_attack_strength)
        : ctx?.teamFocus === "away"
          ? readFiniteNumber(ctx?.away_attack_strength, ctx?.model_away_attack_strength)
          : averageFinite(
              readFiniteNumber(ctx?.home_attack_strength, ctx?.model_home_attack_strength),
              readFiniteNumber(ctx?.away_attack_strength, ctx?.model_away_attack_strength)
            );
    if (Number.isFinite(focusedAttackStrength)) {
      tasa = clamp(tasa * 0.75 + focusedAttackStrength * 0.25, 0.1, 0.9);
    }
  }
  const G = tasa >= 0.68 ? 7 : tasa >= 0.55 ? 5 : tasa >= 0.42 ? 3 : 1;

  const lesionesActivas = (ctx?.lesiones || []).filter((entry) => ["out", "doubtful"].includes(entry.status));
  const bajas = lesionesActivas.length;
  const lineupCoverage = Boolean(ctx?.lineup_confirmed || ctx?.home_lineup_confirmed || ctx?.away_lineup_confirmed);
  const bothLineupsConfirmed = Boolean(ctx?.home_lineup_confirmed && ctx?.away_lineup_confirmed);
  const positionWeightMap = { gk: 2.5, goalkeeper: 2.5, fw: 2.0, forward: 2.0, striker: 2.0, mf: 1.5, midfielder: 1.5, df: 1.0, defender: 1.0 };
  const weightedBajas = lesionesActivas.reduce((sum, entry) => {
    const pos = String(entry.position || "").toLowerCase();
    const w = positionWeightMap[pos] ?? 1.2;
    return sum + w;
  }, 0);
  const weightedBajasEffective = bajas > 0 ? weightedBajas / bajas : 0;
  let H = weightedBajasEffective === 0 ? 7 : weightedBajasEffective < 1.5 ? 4 : weightedBajasEffective < 2.5 ? 1 : 0;
  if (!lineupCoverage) {
    H = Math.max(0, H - 3);
  } else if (bothLineupsConfirmed && bajas === 0) {
    H = Math.min(H + 1, 8);
  }

  const pct = (ctx?.posicion || 10) / (ctx?.total_equipos || 20);
  const I = pct <= 0.15 ? 7 : pct <= 0.3 ? 5 : pct <= 0.5 ? 3 : 1;

  let senales = 0;
  if (ev >= 0.05) senales += 1;
  if (drop12h >= 8 && dropBetSide === betSide) senales += 1;
  if (Math.abs(gap) >= 0.08) senales += 1;
  const combinedBtts = averageFinite(ctx?.home_btts_rate, ctx?.away_btts_rate, ctx?.h2h_btts_rate, ctx?.model_btts_rate);
  const combinedOver25 = averageFinite(ctx?.home_over25_rate, ctx?.away_over25_rate, ctx?.h2h_over25_rate);
  const isGoalTotalMarket = mercado === "Totals" || mercado === "Totals HT" || String(mercado).includes("Team Total");

  if (isGoalTotalMarket) {
    if (apiSportsUnderOverAligns(ctx, betSide)) {
      senales += 1;
    }
    if (
      betSide === "over" &&
      (
        (Number.isFinite(combinedBtts) && combinedBtts >= 0.58) ||
        (Number.isFinite(combinedOver25) && combinedOver25 >= 0.58)
      )
    ) {
      senales += 1;
    }
    if (betSide === "under" && Number.isFinite(combinedOver25) && combinedOver25 <= 0.30) {
      senales += 1;
    }
  }

  if (mercado === "ML" || mercado === "Spread" || mercado === "Spread HT") {
    const focusedShotsOnTarget =
      ctx?.teamFocus === "home" ? readFiniteNumber(ctx?.home_shots_on_target) : ctx?.teamFocus === "away" ? readFiniteNumber(ctx?.away_shots_on_target) : null;
    const rivalShotsOnTarget =
      ctx?.teamFocus === "home" ? readFiniteNumber(ctx?.away_shots_on_target) : ctx?.teamFocus === "away" ? readFiniteNumber(ctx?.home_shots_on_target) : null;
    if (
      Number.isFinite(focusedShotsOnTarget) &&
      Number.isFinite(rivalShotsOnTarget) &&
      rivalShotsOnTarget > 0 &&
      focusedShotsOnTarget / rivalShotsOnTarget >= 1.4
    ) {
      senales += 1;
    }
  }

  const J = senales >= 4 ? 8 : senales === 3 ? 6 : senales === 2 ? 4 : senales === 1 ? 2 : 0;

  const restDaysHome = computeRestDays(ctx?.home_recent_matches, nextMatchDate);
  const restDaysAway = computeRestDays(ctx?.away_recent_matches, nextMatchDate);
  let K = 0;
  if (Number.isFinite(restDaysHome) && Number.isFinite(restDaysAway)) {
    const diff = restDaysHome - restDaysAway;
    if (betSide === "home") {
      K = diff >= 5 ? 3 : diff >= 3 ? 2 : 0;
    } else if (betSide === "away") {
      K = -diff >= 5 ? 3 : -diff >= 3 ? 2 : 0;
    }
  }

  const h2hHomeRate = ctx?.h2h_home_win_rate;
  const h2hAwayRate = ctx?.h2h_away_win_rate;
  const h2hOver25Rate = ctx?.h2h_over25_rate;
  let L = 0;
  if (betSide === "home" && Number.isFinite(h2hHomeRate)) {
    L = h2hHomeRate >= 0.65 ? 5 : h2hHomeRate >= 0.55 ? 3 : h2hHomeRate <= 0.35 ? 0 : 1;
  } else if (betSide === "away" && Number.isFinite(h2hAwayRate)) {
    L = h2hAwayRate >= 0.65 ? 5 : h2hAwayRate >= 0.55 ? 3 : h2hAwayRate <= 0.35 ? 0 : 1;
  } else if ((betSide === "over" || betSide === "under") && Number.isFinite(h2hOver25Rate)) {
    if (betSide === "over") L = h2hOver25Rate >= 0.65 ? 5 : h2hOver25Rate >= 0.55 ? 3 : 1;
    else L = h2hOver25Rate <= 0.35 ? 5 : h2hOver25Rate <= 0.45 ? 3 : 1;
  }

  const total = A + B + C + D + E + F + G + H + I + J + K + L;

  return {
    total: Math.min(total, 100),
    scores: {
      A_ev: A,
      B_drop: B,
      C_gap: C,
      D_cuota: D,
      E_forma: E,
      F_contexto: F,
      G_local: G,
      H_lesiones: H,
      I_tabla: I,
      J_consistencia: J,
      K_descanso: K,
      L_h2h: L,
      restDaysHome,
      restDaysAway,
    },
    valueBook: gap > 0 ? "Winamax FR" : "Bet365",
    bestOdds,
    bet365Odds: bet365,
    winamaxOdds: winamax,
    gap: gap.toFixed(2),
    senalDoble: ev >= FOOTBALL_EV_MIN && drop12h >= FOOTBALL_DROP_MIN && dropBetSide === betSide,
    bajasTitulares: bajas,
  };
}

function esVerde(ev, odds, conf, bajas, senalDoble, mercado, ctx = null) {
  if (!hasRealDataForPick(ctx)) return false;
  const isFirstHalf = String(mercado).includes("HT");
  const evMin = mercado === "Double Chance" ? 0.04 : FOOTBALL_EV_VERDE;
  let threshold =
    mercado === "Double Chance"
      ? senalDoble
        ? FOOTBALL_VERDE_CONF_MIN
        : FOOTBALL_VERDE_CONF_MIN
      : senalDoble
        ? FOOTBALL_VERDE_CONF_MIN
        : FOOTBALL_VERDE_CONF_MIN;

  // Un value-bet puro con EV alto no debe quedarse fuera por 2-7 puntos
  // de confianza cuando el mercado ya valida la ineficiencia.
  if (ev >= 0.08) threshold -= 7;
  else if (ev >= 0.06) threshold -= 4;
  if (isFirstHalf && ev >= 0.05) threshold -= 2;

  threshold = Math.max(threshold, FOOTBALL_VERDE_CONF_MIN, FOOTBALL_RECOMMENDATION_CONF_MIN);
  return (
    ev >= evMin &&
    odds >= FOOTBALL_MIN_ODDS &&
    odds <= FOOTBALL_MAX_ODDS &&
    conf >= threshold &&
    bajas < 3
  );
}

function esAmarillo(ev, odds, conf, bajas, senalDoble, mercado, ctx = null) {
  if (!hasRealDataForPick(ctx)) return false;
  const isFirstHalf = String(mercado).includes("HT");
  const evMin = mercado === "Double Chance" ? 0.04 : FOOTBALL_EV_AMARILLO;
  let threshold = FOOTBALL_AMARILLO_CONF_MIN;
  if (ev >= 0.06) threshold -= 3;
  if (isFirstHalf && ev >= 0.05) threshold -= 2;
  threshold = Math.max(threshold, FOOTBALL_AMARILLO_CONF_MIN);
  return (
    ev >= evMin &&
    odds >= FOOTBALL_MIN_ODDS &&
    odds <= FOOTBALL_MAX_ODDS &&
    conf >= threshold &&
    bajas < 3 &&
    !esVerde(ev, odds, conf, bajas, senalDoble, mercado, ctx)
  );
}

function normalizeMarketRow(row) {
  return {
    home: row?.home,
    away: row?.away,
    draw: row?.draw,
    "1X": row?.["1X"],
    "X2": row?.["X2"],
    "12": row?.["12"],
    over: row?.over,
    under: row?.under,
    hdp: row?.hdp || row?.max || row?.line,
  };
}

function normalizeMarket(market) {
  const row = market?.odds?.[0] || market?.odds || market || {};
  return normalizeMarketRow(row);
}

function ingestOddsMultiEntry(oddsMap, entry) {
  if (!entry?.id) return;
  oddsMap[entry.id] = oddsMap[entry.id] || {};

  const bookmakers = entry.bookmakers;
  if (Array.isArray(bookmakers)) {
    bookmakers.forEach((bookmaker) => {
      oddsMap[entry.id][bookmaker.name] = oddsMap[entry.id][bookmaker.name] || {};
      for (const market of bookmaker.markets || []) {
        oddsMap[entry.id][bookmaker.name][market.name] = normalizeMarket(market);
      }
    });
    return;
  }

  if (!bookmakers || typeof bookmakers !== "object") return;

  for (const [bookmakerName, markets] of Object.entries(bookmakers)) {
    oddsMap[entry.id][bookmakerName] = oddsMap[entry.id][bookmakerName] || {};
    const marketList = Array.isArray(markets) ? markets : [];

    for (const market of marketList) {
      const marketName = market?.name || market?.market || "ML";
      const row = Array.isArray(market?.odds) ? market.odds[0] : market?.odds || market;
      oddsMap[entry.id][bookmakerName][marketName] = normalizeMarketRow(row);
    }
  }
}

function formatSeleccion(mercado, betSide, hdp, evento) {
  if (mercado === "ML") {
    if (betSide === "home") return `${evento.home} gana el partido`;
    if (betSide === "away") return `${evento.away} gana el partido`;
    if (betSide === "draw") return "Empate al final del partido";
  }

  if (mercado === "Double Chance") {
    if (betSide === "1X") return `${evento.home} gana o empata (doble oportunidad)`;
    if (betSide === "X2") return `${evento.away} gana o empata (doble oportunidad)`;
    if (betSide === "12") return "Gana cualquiera de los dos equipos, sin empate";
  }

  if (mercado === "Totals") return formatFootballOverUnderSelection(betSide, hdp, "goles", "partido");
  if (mercado === "Totals HT") return formatFootballOverUnderSelection(betSide, hdp, "goles", "1a mitad");
  if (mercado === "Corners Totals") return formatFootballOverUnderSelection(betSide, hdp, "corners", "partido");
  if (mercado === "Corners Totals HT") return formatFootballOverUnderSelection(betSide, hdp, "corners", "1a mitad");
  if (mercado === "Bookings Totals") return formatFootballOverUnderSelection(betSide, hdp, "tarjetas", "partido");

  if (mercado === "Spread" && betSide === "home") {
    return formatFootballHandicapSelection(evento.home, evento.away, hdp, "goles", "partido");
  }
  if (mercado === "Spread" && betSide === "away") {
    return formatFootballHandicapSelection(evento.away, evento.home, hdp, "goles", "partido");
  }
  if (mercado === "Spread HT" && betSide === "home") {
    return formatFootballHandicapSelection(evento.home, evento.away, hdp, "goles", "1a mitad");
  }
  if (mercado === "Spread HT" && betSide === "away") {
    return formatFootballHandicapSelection(evento.away, evento.home, hdp, "goles", "1a mitad");
  }
  if (mercado === "Team Total Home") return formatFootballTeamTotalSelection(evento.home, betSide, hdp, "goles");
  if (mercado === "Team Total Away") return formatFootballTeamTotalSelection(evento.away, betSide, hdp, "goles");

  return `${mercado} ${betSide}${hdp != null ? ` linea ${formatFootballLineValue(hdp)}` : ""}`.trim();
}

function formatFootballSignedLine(value) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return null;
  return `${number > 0 ? "+" : ""}${number}`;
}

function formatFootballLineValue(value) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return value == null ? "" : String(value).trim();
  return String(number);
}

function footballTeamBySide(evento, betSide) {
  if (betSide === "home") return evento.home;
  if (betSide === "away") return evento.away;
  return null;
}

function footballOpponentBySide(evento, betSide) {
  if (betSide === "home") return evento.away;
  if (betSide === "away") return evento.home;
  return null;
}

function footballPeriodLabel(period) {
  return period === "1a mitad" ? "en la 1a mitad" : "en el partido";
}

function formatFootballOverUnderSelection(betSide, line, unit, period = "partido") {
  const lineText = formatFootballLineValue(line) || "la linea";
  const periodText = footballPeriodLabel(period);
  if (betSide === "over") return `Mas de ${lineText} ${unit} ${periodText}`;
  if (betSide === "under") return `Menos de ${lineText} ${unit} ${periodText}`;
  return `Total de ${unit} ${periodText}: linea ${lineText}`;
}

function formatFootballTeamTotalSelection(team, betSide, line, unit = "goles") {
  const lineText = formatFootballLineValue(line) || "la linea";
  if (betSide === "over") return `${team}: mas de ${lineText} ${unit}`;
  if (betSide === "under") return `${team}: menos de ${lineText} ${unit}`;
  return `${team}: total de ${unit}, linea ${lineText}`;
}

function formatFootballHandicapSelection(team, opponent, line, unit, period = "partido") {
  const number = Number.parseFloat(line);
  const signedLine = formatFootballSignedLine(line) || formatFootballLineValue(line);
  const periodText = footballPeriodLabel(period);
  const rival = opponent || "el rival";
  const rivalTarget = opponent ? `a ${opponent}` : "al rival";

  if (!Number.isFinite(number)) {
    const comparison = unit === "goles" ? "marcador" : `conteo de ${unit}`;
    return `${team}: debe quedar por delante en el ${comparison} ${periodText} contra ${rival}. Linea no informada.`;
  }

  if (number < 0) {
    const absLine = Math.abs(number);
    const needed = Math.floor(absLine) + 1;
    const pushText = Number.isInteger(absLine)
      ? ` Si gana por ${formatFootballLineValue(absLine)}, se devuelve.`
      : "";
    return `${team} ${signedLine} ${unit}: necesita superar ${rivalTarget} por ${needed}+ ${unit} ${periodText}.${pushText}`;
  }

  if (number > 0) {
    const absLine = Math.abs(number);
    if (Number.isInteger(absLine)) {
      const maxLoss = Math.max(0, absLine - 1);
      if (maxLoss === 0) {
        return `${team} ${signedLine} ${unit}: gana si supera o empata contra ${rival} ${periodText}. Si pierde por ${formatFootballLineValue(absLine)}, se devuelve.`;
      }
      return `${team} ${signedLine} ${unit}: gana si supera, empata o pierde contra ${rival} por ${formatFootballLineValue(maxLoss)} ${unit} o menos ${periodText}. Si pierde por ${formatFootballLineValue(absLine)}, se devuelve.`;
    }
    return `${team} ${signedLine} ${unit}: gana si supera, empata o pierde contra ${rival} por menos de ${formatFootballLineValue(absLine)} ${unit} ${periodText}.`;
  }

  return `${team} 0 ${unit}: necesita superar ${rivalTarget} ${periodText}; empate en ${unit} devuelve la apuesta.`;
}

function formatFootballSelection(mercado, betSide, hdp, evento) {
  const team = footballTeamBySide(evento, betSide);
  const opponent = footballOpponentBySide(evento, betSide);

  if (mercado === "ML") {
    if (betSide === "draw") return "Empate al final del partido";
    if (team) return `${team} gana el partido`;
  }

  if (mercado === "Double Chance") {
    if (betSide === "1X") return `${evento.home} gana o empata (doble oportunidad)`;
    if (betSide === "X2") return `${evento.away} gana o empata (doble oportunidad)`;
    if (betSide === "12") return "Gana cualquiera de los dos equipos, sin empate";
    return `Double Chance ${betSide}`;
  }

  if (mercado === "Totals") {
    return formatFootballOverUnderSelection(betSide, hdp, "goles", "partido");
  }

  if (mercado === "Totals HT") {
    return formatFootballOverUnderSelection(betSide, hdp, "goles", "1a mitad");
  }

  if (mercado === "Spread" && team) {
    return formatFootballHandicapSelection(team, opponent, hdp, "goles", "partido");
  }

  if (mercado === "Spread HT" && team) {
    return formatFootballHandicapSelection(team, opponent, hdp, "goles", "1a mitad");
  }

  if (mercado === "Corners Totals") {
    if (betSide === "over" || betSide === "under") return formatFootballOverUnderSelection(betSide, hdp, "corners", "partido");
    // Some feeds mislabel total-corners sides as home/away; avoid inventing a team-total pick.
    if (team) return `Total de corners en el partido: linea ${formatFootballLineValue(hdp) || "sin linea"}`;
  }

  if (mercado === "Corners Totals HT") {
    if (betSide === "over" || betSide === "under") return formatFootballOverUnderSelection(betSide, hdp, "corners", "1a mitad");
    if (team) return `Total de corners en la 1a mitad: linea ${formatFootballLineValue(hdp) || "sin linea"}`;
  }

  if (mercado === "Bookings Totals") {
    if (betSide === "over" || betSide === "under") return formatFootballOverUnderSelection(betSide, hdp, "tarjetas", "partido");
    // Some feeds mislabel total-bookings sides as home/away; avoid inventing a team-total pick.
    if (team) return `Total de tarjetas en el partido: linea ${formatFootballLineValue(hdp) || "sin linea"}`;
  }

  if (mercado === "Team Total Home") {
    return formatFootballTeamTotalSelection(evento.home, betSide, hdp, "goles");
  }

  if (mercado === "Team Total Away") {
    return formatFootballTeamTotalSelection(evento.away, betSide, hdp, "goles");
  }

  if (mercado === "Corners Spread" && team) {
    return formatFootballHandicapSelection(team, opponent, hdp, "corners", "partido");
  }

  if (mercado === "Bookings Spread" && team) {
    return formatFootballHandicapSelection(team, opponent, hdp, "tarjetas", "partido");
  }

  return formatSeleccion(mercado, betSide, hdp, evento);
}

function formatFootballBookSearchLabel(mercado, betSide, hdp, evento) {
  const team = footballTeamBySide(evento, betSide);
  const sideLabel = betSide === "home" ? "home" : betSide === "away" ? "away" : betSide;
  const parts = [mercado];

  if (team && (betSide === "home" || betSide === "away")) {
    parts.push(team);
  } else if (sideLabel) {
    parts.push(sideLabel);
  }

  if (hdp != null && hdp !== "") {
    parts.push(`linea ${hdp}`);
  }

  return parts.join(" | ");
}

function formatPct(value) {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(value * 100)}%`;
}

function buildFootballPickNarrative(mercado, evento, ctx, evPercent, confidence) {
  const expectedGoals = ctx?.expected_goals;
  const expectedCorners = ctx?.expected_corners_total;
  const expectedCards = ctx?.expected_cards_total;
  const h2hLabel = ctx?.h2h_market_label || null;
  const lineupLabel = ctx?.lineup_confirmed
    ? ctx?.home_lineup_confirmed && ctx?.away_lineup_confirmed
      ? "Alineaciones confirmadas por API-Sports."
      : "Alineacion confirmada por API-Sports."
    : null;

  if (mercado === "Totals") {
    return [
      Number.isFinite(expectedGoals) ? `Modelo ESPN proyecta ${expectedGoals.toFixed(1)} goles.` : null,
      Number.isFinite(ctx?.h2h_over25_rate) ? `H2H over 2.5: ${formatPct(ctx.h2h_over25_rate)}.` : null,
      lineupLabel,
      `EV ${evPercent} y confianza ${confidence}.`,
    ].filter(Boolean).join(" ");
  }

  if (mercado === "Totals HT") {
    return [
      Number.isFinite(expectedGoals) ? `Modelo ESPN proyecta ${(expectedGoals * 0.46).toFixed(1)} goles en la 1a mitad.` : null,
      lineupLabel,
      `EV ${evPercent} y confianza ${confidence}.`,
    ].filter(Boolean).join(" ");
  }

  if (mercado === "Corners Totals" || mercado === "Corners Spread") {
    const homeCornerStr = (Number.isFinite(ctx?.home_corners_for) && Number.isFinite(ctx?.home_corners_against))
      ? `${evento.home}: ${ctx.home_corners_for.toFixed(1)} a favor / ${ctx.home_corners_against.toFixed(1)} en contra.`
      : Number.isFinite(ctx?.home_corners_for)
        ? `${evento.home} promedia ${ctx.home_corners_for.toFixed(1)} corners.`
        : null;
    const awayCornerStr = (Number.isFinite(ctx?.away_corners_for) && Number.isFinite(ctx?.away_corners_against))
      ? `${evento.away}: ${ctx.away_corners_for.toFixed(1)} a favor / ${ctx.away_corners_against.toFixed(1)} en contra.`
      : Number.isFinite(ctx?.away_corners_for)
        ? `${evento.away} promedia ${ctx.away_corners_for.toFixed(1)} corners.`
        : null;
    return [
      Number.isFinite(expectedCorners) ? `Modelo ESPN proyecta ${expectedCorners.toFixed(1)} corners totales.` : null,
      homeCornerStr,
      awayCornerStr,
      lineupLabel,
      `EV ${evPercent} y confianza ${confidence}.`,
    ].filter(Boolean).join(" ");
  }

  if (mercado === "Corners Totals HT") {
    return [
      Number.isFinite(expectedCorners) ? `Modelo ESPN proyecta ${(expectedCorners * 0.48).toFixed(1)} corners en la 1a mitad.` : null,
      lineupLabel,
      `EV ${evPercent} y confianza ${confidence}.`,
    ].filter(Boolean).join(" ");
  }

  if (mercado === "Bookings Totals" || mercado === "Bookings Spread") {
    return [
      Number.isFinite(expectedCards) ? `Modelo ESPN proyecta ${expectedCards.toFixed(1)} tarjetas.` : null,
      Number.isFinite(ctx?.home_cards_for) ? `${evento.home} ve ${ctx.home_cards_for.toFixed(1)} tarjetas por juego.` : null,
      Number.isFinite(ctx?.away_cards_for) ? `${evento.away} ve ${ctx.away_cards_for.toFixed(1)} tarjetas por juego.` : null,
      lineupLabel,
      `EV ${evPercent} y confianza ${confidence}.`,
    ].filter(Boolean).join(" ");
  }

  if (mercado === "ML" || mercado === "Spread" || mercado === "Double Chance") {
    const poissonHome = Number.isFinite(ctx?.model_home_prob) ? `Poisson: ${evento.home} ${formatPct(ctx.model_home_prob)} / empate ${formatPct(ctx.model_draw_prob)} / ${evento.away} ${formatPct(ctx.model_away_prob)}.` : null;
    return [
      poissonHome,
      !poissonHome && Number.isFinite(ctx?.home_win_rate) ? `${evento.home} gana ${formatPct(ctx.home_win_rate)} en su forma reciente.` : null,
      !poissonHome && Number.isFinite(ctx?.away_win_rate) ? `${evento.away} gana ${formatPct(ctx.away_win_rate)} en su forma reciente.` : null,
      h2hLabel,
      lineupLabel,
      `EV ${evPercent} y confianza ${confidence}.`,
    ].filter(Boolean).join(" ");
  }

  if (mercado === "Spread HT") {
    const poissonHome = Number.isFinite(ctx?.model_home_prob) ? `Poisson 1a mitad conservador: ${evento.home} ${formatPct(ctx.model_home_prob)} / empate ${formatPct(ctx.model_draw_prob)} / ${evento.away} ${formatPct(ctx.model_away_prob)}.` : null;
    return [poissonHome, lineupLabel, `EV ${evPercent} y confianza ${confidence}.`].filter(Boolean).join(" ");
  }

  return [h2hLabel, lineupLabel, `EV ${evPercent} y confianza ${confidence}.`].filter(Boolean).join(" ");
}

function buildFootballSupportLabel(ctx, mercado) {
  if (ctx?.h2h_market_label) return ctx.h2h_market_label;
  if (ctx?.lineup_confirmed) {
    return ctx?.home_lineup_confirmed && ctx?.away_lineup_confirmed
      ? "API-Sports: alineaciones confirmadas"
      : "API-Sports: alineacion confirmada";
  }
  if ((mercado === "Corners Totals" || mercado === "Corners Spread") && Number.isFinite(ctx?.expected_corners_total)) {
    return `Modelo corners ${ctx.expected_corners_total.toFixed(1)}`;
  }
  if (mercado === "Corners Totals HT" && Number.isFinite(ctx?.expected_corners_total)) {
    return `Modelo corners 1a mitad ${(ctx.expected_corners_total * 0.48).toFixed(1)}`;
  }
  if ((mercado === "Bookings Totals" || mercado === "Bookings Spread") && Number.isFinite(ctx?.expected_cards_total)) {
    return `Modelo tarjetas ${ctx.expected_cards_total.toFixed(1)}`;
  }
  if (mercado === "Totals" && Number.isFinite(ctx?.expected_goals)) {
    return `Modelo goles ${ctx.expected_goals.toFixed(1)}`;
  }
  if (mercado === "Totals HT" && Number.isFinite(ctx?.expected_goals)) {
    return `Modelo goles 1a mitad ${(ctx.expected_goals * 0.46).toFixed(1)}`;
  }
  return "Cruce stats ESPN";
}

function normalizeLeagueKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function leagueEntryIsGeneric(entry) {
  return !/^(england|spain|germany|italy|france|netherlands|portugal|turkey|belgium|scotland|russia|mexico|argentina|brazil|europe|world|fifa|uefa|concacaf|africa)-/.test(entry);
}

function leagueMatchesEntry(evento, entry) {
  const slug = normalizeLeagueKey(evento?.league?.slug);
  const name = normalizeLeagueKey(evento?.league?.name || evento?.league);
  const key = normalizeLeagueKey(entry);
  if (!key) return false;

  if (slug === key || name === key) return true;
  if (leagueEntryIsGeneric(key)) return false;
  return slug.includes(key) || name.includes(key);
}

function getLeagueTier(evento) {
  if (isSeniorInternationalFriendly(evento)) return 2;
  const matches = (list) => list.some((entry) => leagueMatchesEntry(evento, entry));
  if (matches(TIER1_LEAGUES)) return 3;
  if (matches(TIER2_LEAGUES)) return 2;
  if (matches(TIER3_LEAGUES)) return 1;
  return 0;
}

function getFootballLeaguePriority(evento) {
  const tier = getLeagueTier(evento);
  if (tier === 0) return 0;
  const list = tier === 3 ? TIER1_LEAGUES : tier === 2 ? TIER2_LEAGUES : TIER3_LEAGUES;
  const index = list.findIndex((entry) => leagueMatchesEntry(evento, entry));
  // tier * 100 gives separation between tiers; position within tier breaks ties
  return tier * 100 + (index === -1 ? 0 : list.length - index);
}

function isTopLeague(evento) {
  return getLeagueTier(evento) > 0;
}

function hasFootballEspnContext(evento, espnStats = {}) {
  return espnStats[evento?.id]?.__source === "espn-site-api";
}

function shouldIncludeFootballEvent(evento, espnStats = {}, valueBetCount = 0) {
  if (isYouthOrExcludedEvent(evento)) return false;
  if (isSeniorInternationalFriendly(evento)) return true;
  return isTopLeague(evento);
}

function getFootballEventScore(evento, valueBetCount = 0) {
  const tier = getLeagueTier(evento);
  return tier * 10 + (valueBetCount > 0 ? 5 : 0) + Math.min(valueBetCount, 3);
}

function resolveFootballContext(baseCtx, mercado, betSide) {
  const homeGoalsFor = baseCtx?.home_goals_for ?? baseCtx?.goles_favor_local ?? 0;
  const awayGoalsFor = baseCtx?.away_goals_for ?? baseCtx?.goles_favor_away ?? 0;
  const homeForm = Array.isArray(baseCtx?.home_forma)
    ? baseCtx.home_forma
    : Array.isArray(baseCtx?.forma)
      ? baseCtx.forma
      : [];
  const awayForm = Array.isArray(baseCtx?.away_forma)
    ? baseCtx.away_forma
    : Array.isArray(baseCtx?.forma)
      ? baseCtx.forma
      : [];
  const homeInjuries = Array.isArray(baseCtx?.home_lesiones)
    ? baseCtx.home_lesiones
    : Array.isArray(baseCtx?.lesiones)
      ? baseCtx.lesiones
      : [];
  const awayInjuries = Array.isArray(baseCtx?.away_lesiones)
    ? baseCtx.away_lesiones
    : Array.isArray(baseCtx?.lesiones)
      ? baseCtx.lesiones
      : [];

  let teamFocus = "neutral";
  if (mercado === "Team Total Home") {
    teamFocus = "home";
  } else if (mercado === "Team Total Away") {
    teamFocus = "away";
  } else if (mercado === "Double Chance") {
    teamFocus = betSide === "1X" ? "home" : betSide === "X2" ? "away" : "neutral";
  } else if (["ML", "Spread", "Spread HT", "Corners Spread", "Bookings Spread"].includes(mercado)) {
    teamFocus = betSide === "home" ? "home" : betSide === "away" ? "away" : "neutral";
  }

  const homeInj = computeFootballInjuryImpact({ injuries: homeInjuries });
  const awayInj = computeFootballInjuryImpact({ injuries: awayInjuries });
  const injuryGoalDelta = (homeInj.injuryPenalty + awayInj.injuryPenalty) * 0.06;
  const adjustedHomeGoals = Math.max(0.4, homeGoalsFor - homeInj.injuryPenalty * 0.08);
  const adjustedAwayGoals = Math.max(0.4, awayGoalsFor - awayInj.injuryPenalty * 0.08);
  const baseExpectedGoals = baseCtx?.expected_goals ?? null;
  const adjustedExpectedGoals =
    baseExpectedGoals != null ? Math.max(1.2, baseExpectedGoals - injuryGoalDelta) : baseExpectedGoals;

  return {
    ...baseCtx,
    teamFocus,
    forma: teamFocus === "home" ? homeForm : teamFocus === "away" ? awayForm : homeForm,
    goles_favor_equipo:
      teamFocus === "home" ? adjustedHomeGoals : teamFocus === "away" ? adjustedAwayGoals : (adjustedHomeGoals + adjustedAwayGoals) / 2,
    expected_goals: adjustedExpectedGoals,
    lambda_home: baseCtx?.lambda_home ?? baseCtx?.model_goals_home ?? null,
    lambda_away: baseCtx?.lambda_away ?? baseCtx?.model_goals_away ?? null,
    expected_corners_total: baseCtx?.expected_corners_total ?? null,
    expected_cards_total: baseCtx?.expected_cards_total ?? null,
    home_corners_for: baseCtx?.home_corners_for ?? null,
    away_corners_for: baseCtx?.away_corners_for ?? null,
    home_corners_against: baseCtx?.home_corners_against ?? null,
    away_corners_against: baseCtx?.away_corners_against ?? null,
    home_cards_for: baseCtx?.home_cards_for ?? null,
    away_cards_for: baseCtx?.away_cards_for ?? null,
    home_cards_against: baseCtx?.home_cards_against ?? null,
    away_cards_against: baseCtx?.away_cards_against ?? null,
    home_shots_for: baseCtx?.home_shots_for ?? null,
    away_shots_for: baseCtx?.away_shots_for ?? null,
    home_shots_on_target: baseCtx?.home_shots_on_target ?? null,
    away_shots_on_target: baseCtx?.away_shots_on_target ?? null,
    home_goals_against: baseCtx?.home_goals_against ?? null,
    away_goals_against: baseCtx?.away_goals_against ?? null,
    home_season_goals_against: baseCtx?.home_season_goals_against ?? null,
    away_season_goals_against: baseCtx?.away_season_goals_against ?? null,
    home_btts_rate: baseCtx?.home_btts_rate ?? null,
    away_btts_rate: baseCtx?.away_btts_rate ?? null,
    model_btts_rate: baseCtx?.model_btts_rate ?? null,
    home_over25_rate: baseCtx?.home_over25_rate ?? null,
    away_over25_rate: baseCtx?.away_over25_rate ?? null,
    home_win_rate_home: baseCtx?.home_win_rate_home ?? null,
    away_win_rate_away: baseCtx?.away_win_rate_away ?? null,
    home_attack_strength: baseCtx?.home_attack_strength ?? baseCtx?.model_home_attack_strength ?? null,
    away_attack_strength: baseCtx?.away_attack_strength ?? baseCtx?.model_away_attack_strength ?? null,
    home_defence_strength: baseCtx?.home_defence_strength ?? baseCtx?.model_home_defence_strength ?? null,
    away_defence_strength: baseCtx?.away_defence_strength ?? baseCtx?.model_away_defence_strength ?? null,
    home_recent_matches: baseCtx?.home_recent_matches ?? [],
    away_recent_matches: baseCtx?.away_recent_matches ?? [],
    h2h_market_label: baseCtx?.h2h_market_label || null,
    h2h_home_win_rate: baseCtx?.h2h_home_win_rate ?? baseCtx?.model_h2h_home_rate ?? null,
    h2h_draw_rate: baseCtx?.h2h_draw_rate ?? baseCtx?.model_h2h_draw_rate ?? null,
    h2h_away_win_rate: baseCtx?.h2h_away_win_rate ?? baseCtx?.model_h2h_away_rate ?? null,
    h2h_over25_rate: baseCtx?.h2h_over25_rate ?? null,
    h2h_btts_rate: baseCtx?.h2h_btts_rate ?? null,
    h2h_avg_goals: baseCtx?.h2h_avg_goals ?? null,
    api_sports_under_over: baseCtx?.api_sports_under_over ?? baseCtx?.model_under_over ?? null,
    api_sports_has_predictions: Boolean(baseCtx?.api_sports_has_predictions),
    lineup_confirmed: Boolean(baseCtx?.lineup_confirmed),
    home_lineup_confirmed: Boolean(baseCtx?.home_lineup_confirmed),
    away_lineup_confirmed: Boolean(baseCtx?.away_lineup_confirmed),
    fixture_status: baseCtx?.fixture_status || null,
    fixture_status_label: baseCtx?.fixture_status_label || null,
    posicion:
      teamFocus === "home"
        ? baseCtx?.home_posicion ?? baseCtx?.posicion ?? 10
        : teamFocus === "away"
          ? baseCtx?.away_posicion ?? baseCtx?.posicion ?? 10
          : baseCtx?.posicion ?? 10,
    total_equipos: baseCtx?.total_equipos ?? 20,
    lesiones: teamFocus === "home" ? homeInjuries : teamFocus === "away" ? awayInjuries : [...homeInjuries, ...awayInjuries],
  };
}

function buildFallbackFootballCtx(evento) {
  const topLeague = isTopLeague(evento);
  const homeGoalsFor = topLeague ? 1.55 : 1.4;
  const awayGoalsFor = topLeague ? 1.2 : 1.1;

  return {
    forma: [],
    home_forma: [],
    away_forma: [],
    goles_favor_local: homeGoalsFor,
    goles_favor_away: awayGoalsFor,
    home_goals_for: homeGoalsFor,
    away_goals_for: awayGoalsFor,
    home_goals_against: topLeague ? 1.15 : 1.3,
    away_goals_against: topLeague ? 1.35 : 1.45,
    home_season_goals_against: null,
    away_season_goals_against: null,
    home_btts_rate: null,
    away_btts_rate: null,
    home_over25_rate: null,
    away_over25_rate: null,
    home_win_rate: topLeague ? 0.46 : 0.42,
    away_win_rate: topLeague ? 0.31 : 0.28,
    home_win_rate_home: topLeague ? 0.5 : 0.44,
    away_win_rate_away: topLeague ? 0.3 : 0.28,
    home_recent_matches: [],
    away_recent_matches: [],
    posicion: topLeague ? 8 : 10,
    home_posicion: topLeague ? 8 : 10,
    away_posicion: topLeague ? 10 : 11,
    total_equipos: 20,
    lesiones: [],
    home_lesiones: [],
    away_lesiones: [],
    lineup_confirmed: false,
    home_lineup_confirmed: false,
    away_lineup_confirmed: false,
    fixture_status: null,
    fixture_status_label: null,
    esTopLeague: topLeague,
    __source: "priors",
    __insight: null,
  };
}

async function loadESPNSoccerStats(eventosHoy, date) {
  const stats = {};
  let insights = {};

  try {
    insights = await loadEspnSoccerInsights(eventosHoy, date);
  } catch {
    insights = {};
  }

  for (const evento of eventosHoy || []) {
    const fallback = buildFallbackFootballCtx(evento);
    const insight = insights?.[evento.id] || null;
    stats[evento.id] = insight
      ? {
          ...fallback,
          ...(insight.ctx || {}),
          __source: "espn-site-api",
          __insight: insight,
        }
      : fallback;
  }

  return stats;
}

function hasFootballCtxValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim() !== "";
  return value != null;
}

function mergeFootballSupportContext(baseCtx, apiSportsInsight) {
  if (!apiSportsInsight) return baseCtx;

  const apiCtx = apiSportsInsight.ctx || {};
  const baseSource = String(baseCtx?.__source || baseCtx?.source || "priors");
  const baseIsPriors = baseSource === "priors";
  const source = baseIsPriors ? "api-sports-football" : `${baseSource} + api-sports-football`;
  const apiMapped = {
    ...apiCtx,
    lambda_home: apiCtx.model_goals_home ?? apiCtx.lambda_home ?? null,
    lambda_away: apiCtx.model_goals_away ?? apiCtx.lambda_away ?? null,
    home_goals_for: apiCtx.model_home_goals_for ?? apiCtx.home_goals_for ?? null,
    away_goals_for: apiCtx.model_away_goals_for ?? apiCtx.away_goals_for ?? null,
    goles_favor_local: apiCtx.model_home_goals_for ?? apiCtx.goles_favor_local ?? null,
    goles_favor_away: apiCtx.model_away_goals_for ?? apiCtx.goles_favor_away ?? null,
    home_goals_against: apiCtx.model_home_goals_against ?? apiCtx.home_goals_against ?? null,
    away_goals_against: apiCtx.model_away_goals_against ?? apiCtx.away_goals_against ?? null,
    home_attack_strength: apiCtx.model_home_attack_strength ?? apiCtx.home_attack_strength ?? null,
    away_attack_strength: apiCtx.model_away_attack_strength ?? apiCtx.away_attack_strength ?? null,
    home_defence_strength: apiCtx.model_home_defence_strength ?? apiCtx.home_defence_strength ?? null,
    away_defence_strength: apiCtx.model_away_defence_strength ?? apiCtx.away_defence_strength ?? null,
    h2h_home_win_rate: apiCtx.model_h2h_home_rate ?? apiCtx.h2h_home_win_rate ?? null,
    h2h_draw_rate: apiCtx.model_h2h_draw_rate ?? apiCtx.h2h_draw_rate ?? null,
    h2h_away_win_rate: apiCtx.model_h2h_away_rate ?? apiCtx.h2h_away_win_rate ?? null,
    api_sports_under_over: apiCtx.model_under_over ?? apiCtx.api_sports_under_over ?? null,
    api_sports_has_predictions: Boolean(apiCtx.api_sports_has_predictions),
    model_under_over: apiCtx.model_under_over ?? null,
    model_btts_rate: apiCtx.model_btts_rate ?? null,
  };

  const merged = { ...baseCtx, __source: source };
  const copyKeys = [
    "model_home_prob",
    "model_draw_prob",
    "model_away_prob",
    "model_goals_home",
    "model_goals_away",
    "expected_goals",
    "lambda_home",
    "lambda_away",
    "home_goals_for",
    "away_goals_for",
    "goles_favor_local",
    "goles_favor_away",
    "home_goals_against",
    "away_goals_against",
    "home_season_goals_against",
    "away_season_goals_against",
    "home_attack_strength",
    "away_attack_strength",
    "home_defence_strength",
    "away_defence_strength",
    "home_btts_rate",
    "away_btts_rate",
    "model_btts_rate",
    "home_over25_rate",
    "away_over25_rate",
    "home_win_rate",
    "away_win_rate",
    "home_win_rate_home",
    "away_win_rate_away",
    "home_recent_matches",
    "away_recent_matches",
    "forma",
    "home_forma",
    "away_forma",
    "h2h_home_win_rate",
    "h2h_draw_rate",
    "h2h_away_win_rate",
    "h2h_over25_rate",
    "h2h_btts_rate",
    "h2h_avg_goals",
    "h2h_market_label",
    "expected_corners_total",
    "expected_cards_total",
    "home_corners_for",
    "away_corners_for",
    "home_corners_against",
    "away_corners_against",
    "home_cards_for",
    "away_cards_for",
    "home_cards_against",
    "away_cards_against",
    "home_shots_on_target",
    "away_shots_on_target",
    "api_sports_under_over",
    "api_sports_has_predictions",
    "model_under_over",
    "posicion",
    "home_posicion",
    "away_posicion",
    "total_equipos",
    "home_season_ppg",
    "away_season_ppg",
    "home_venue_advantage",
    "home_gamma",
  ];

  for (const key of copyKeys) {
    const baseValue = baseCtx?.[key];
    const apiValue = apiMapped?.[key];
    merged[key] = !baseIsPriors && hasFootballCtxValue(baseValue)
      ? baseValue
      : hasFootballCtxValue(apiValue)
        ? apiValue
        : baseValue ?? null;
  }

  merged.lineup_confirmed = Boolean(baseCtx?.lineup_confirmed || apiCtx.lineup_confirmed);
  merged.home_lineup_confirmed = Boolean(baseCtx?.home_lineup_confirmed || apiCtx.home_lineup_confirmed);
  merged.away_lineup_confirmed = Boolean(baseCtx?.away_lineup_confirmed || apiCtx.away_lineup_confirmed);
  merged.fixture_status = apiCtx.fixture_status || baseCtx?.fixture_status || null;
  merged.fixture_status_label = apiCtx.fixture_status_label || baseCtx?.fixture_status_label || null;
  merged.lesiones = Array.isArray(baseCtx?.lesiones) && baseCtx.lesiones.length ? baseCtx.lesiones : (apiCtx.lesiones || []);
  merged.home_lesiones = Array.isArray(baseCtx?.home_lesiones) && baseCtx.home_lesiones.length ? baseCtx.home_lesiones : (apiCtx.home_lesiones || []);
  merged.away_lesiones = Array.isArray(baseCtx?.away_lesiones) && baseCtx.away_lesiones.length ? baseCtx.away_lesiones : (apiCtx.away_lesiones || []);
  merged.__insight = {
    ...(baseCtx?.__insight || {}),
    stadium: apiSportsInsight.stadium || baseCtx?.__insight?.stadium || null,
    referee: apiSportsInsight.referee || baseCtx?.__insight?.referee || null,
    status: apiSportsInsight.status || baseCtx?.__insight?.status || null,
    lineups: apiSportsInsight.lineups || baseCtx?.__insight?.lineups || null,
  };

  return merged;
}

function mercadoToType(mercado) {
  if (mercado === "ML" || mercado === "Double Chance") return "result";
  if (mercado.includes("Team Total")) return "team-goals";
  if (mercado.includes("Corners")) return "corners";
  if (mercado.includes("Bookings")) return "bookings";
  if (mercado === "Totals") return "goals";
  return "goals";
}

export async function analyzeFootballSlate(dateStr) {
  const hoy = dateStr || getMadridTodayDateString();

  const skipSignals = oddsApiSkipMarketSignals();
  const [vbBet365, vbWinamax, dropping, events] = await Promise.all([
    skipSignals ? Promise.resolve([]) : loadFootballValueBets("Bet365"),
    skipSignals ? Promise.resolve([]) : loadFootballValueBets("Winamax FR"),
    skipSignals ? Promise.resolve([]) : loadFootballDroppingOdds(FOOTBALL_DROP_MIN, "12h"),
    loadFootballEvents(),
  ]);

  if (!events?.length) {
    return { dataAvailable: false, date: hoy, reason: "Sin eventos" };
  }

  const vbEventCount = {};
  [...vbBet365, ...vbWinamax].forEach((vb) => {
    if (!vb?.eventId) return;
    vbEventCount[vb.eventId] = (vbEventCount[vb.eventId] || 0) + 1;
  });

  const ESTADOS_JUGADO = ["finished", "settled", "cancelled", "postponed", "complete"];
  const candidateEvents = events
    .filter(
      (evento) =>
        isFutbolInSlateWindow(evento, hoy) &&
        !ESTADOS_JUGADO.includes(String(evento.status || "").toLowerCase()) &&
        !isYouthOrExcludedEvent(evento)
    )
    .sort((left, right) => {
      const scoreDiff =
        getFootballEventScore(right, vbEventCount[right.id] || 0) - getFootballEventScore(left, vbEventCount[left.id] || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const priorityDiff = getFootballLeaguePriority(right) - getFootballLeaguePriority(left);
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(left.date || 0).getTime() - new Date(right.date || 0).getTime();
    })
    .slice(0, Math.max(FOOTBALL_MAX_MATCH * 4, 48));

  let espnStats = {};
  try {
    espnStats = await loadESPNSoccerStats(candidateEvents, hoy);
  } catch {
    espnStats = {};
  }

  const eventosHoy = candidateEvents
    .filter((evento) => shouldIncludeFootballEvent(evento, espnStats, vbEventCount[evento.id] || 0))
    .slice(0, FOOTBALL_MAX_MATCH);

  if (!eventosHoy.length) {
    return { dataAvailable: false, date: hoy, reason: "Sin partidos pendientes en la ventana activa" };
  }

  let apiSportsInsights = {};
  try {
    apiSportsInsights = await loadApiSportsFootballInsights(eventosHoy, hoy, _apiSportsCfg);
  } catch {
    apiSportsInsights = {};
  }

  const oddsMap = {};
  const oddsChunkSize = getOddsApiMultiChunkSize();
  for (let index = 0; index < eventosHoy.length; index += oddsChunkSize) {
    const batch = eventosHoy.slice(index, index + oddsChunkSize);
    const multi = await loadFootballOddsMulti(batch.map((evento) => evento.id));
    multi.forEach((entry) => ingestOddsMultiEntry(oddsMap, entry));
  }

  const vbIdx = {};
  const dropIdx = {};
  [...vbBet365, ...vbWinamax].forEach((vb) => {
    if (!vb?.eventId) return;
    if (!vbIdx[vb.eventId]) vbIdx[vb.eventId] = [];
    vbIdx[vb.eventId].push(vb);
  });
  dropping.forEach((entry) => {
    const drop12h = entry.odds?.drop?.["12h"] || 0;
    if (!dropIdx[entry.eventId] || drop12h > (dropIdx[entry.eventId]?.odds?.drop?.["12h"] || 0)) {
      dropIdx[entry.eventId] = entry;
    }
  });

  const partidosRaw = eventosHoy.map((evento) => {
    const vbs = vbIdx[evento.id] || [];
    const drop = dropIdx[evento.id] || null;
    const odds = oddsMap[evento.id] || {};
    const baseCtx = mergeFootballSupportContext(
      espnStats[evento.id] || buildFallbackFootballCtx(evento),
      apiSportsInsights[evento.id] || null
    );
    const insight = baseCtx.__insight || null;
    const picks = [];
    const sin_valor = [];

    for (const mercado of MERCADOS) {
      if (isBookingsMarket(mercado) && !hasRefereeInfo(insight)) continue;
      const allVbsMercado = vbs.filter((vb) => vb.market?.name === mercado);
      if (!allVbsMercado.length) continue;

      // Deduplicate by betSide+line, keeping highest EV per combination
      const dedupMap = new Map();
      for (const vb of allVbsMercado) {
        const key = `${vb.betSide}|${vb.market?.hdp ?? "main"}`;
        const existing = dedupMap.get(key);
        if (!existing || (vb.expectedValue || 0) > (existing.expectedValue || 0)) {
          dedupMap.set(key, vb);
        }
      }
      const vbsMercado = [...dedupMap.values()];

      for (const vb of vbsMercado) {
        const betSide = vb.betSide;
        if (
          mercado === "ML" &&
          !isPickSideCoherentWithModel(
            betSide,
            baseCtx?.model_home_prob,
            baseCtx?.model_draw_prob,
            baseCtx?.model_away_prob
          )
        ) {
          continue;
        }
        const ctx = resolveFootballContext(baseCtx, mercado, betSide);
        const { b365: oddsB365, wmx: oddsWmx } = resolveFootballBookOdds(odds, mercado, betSide);
        const b365 = Number.parseFloat(
          oddsB365 || vb.bookmakerOdds?.[betSide] || 0
        );
        const wmx = Number.parseFloat(
          oddsWmx ||
            vbs.find(
              (entry) => entry.bookmaker === "Winamax FR" && entry.market?.name === mercado && entry.betSide === betSide
            )?.bookmakerOdds?.[betSide] ||
            0
        );
        const hasRealBookOdds = Math.max(b365 || 0, wmx || 0) > 1;
        let ev = hasRealBookOdds ? normalizeExpectedValue(vb.expectedValue || 0) : null;
        // Si el API no da EV pero tenemos probabilidades del modelo (Poisson de API-Sports),
        // calcular EV local para no perder partidos con señal de modelo
        if (ev === 0 && hasRealBookOdds && baseCtx.model_home_prob != null) {
          const { b365: b365Local, wmx: wmxLocal } = resolveFootballBookOdds(odds, mercado, betSide);
          const bestLocal = Math.max(b365Local || b365 || 0, wmxLocal || wmx || 0);
          if (bestLocal > 1) {
            const mHome = baseCtx.model_home_prob;
            // Solo usar mDraw y mAway si la API los proporcionó explícitamente.
            // NO estimar mDraw como (1-mHome) — si mAway es null, el complemento va
            // enteramente al empate e infla Double Chance 1X hasta ~97%.
            const mDraw = Number.isFinite(baseCtx.model_draw_prob) ? baseCtx.model_draw_prob : null;
            const mAway = Number.isFinite(baseCtx.model_away_prob) ? baseCtx.model_away_prob : null;
            let modelProb = null;
            if (mercado === "ML" && betSide === "home") modelProb = mHome;
            else if (mercado === "ML" && betSide === "away" && mAway != null) modelProb = mAway;
            else if (mercado === "ML" && betSide === "draw" && mDraw != null) modelProb = mDraw;
            else if (mercado === "Double Chance" && betSide === "1X" && mDraw != null) modelProb = clamp(mHome + mDraw, 0.3, 0.97);
            else if (mercado === "Double Chance" && betSide === "X2" && mDraw != null && mAway != null) {
              modelProb = clamp(mDraw + mAway, 0.3, 0.97);
            }
            if (modelProb != null) ev = round(modelProb * bestLocal - 1, 3);
          }
        }
        const drop12h = drop?.odds?.drop?.["12h"] || 0;
        const evForScore = Number.isFinite(ev) ? ev : 0;
        const evPercent = Number.isFinite(ev) ? `+${(ev * 100).toFixed(1)}%` : null;

        const sc = calcularScorePick({
          ev: evForScore,
          drop12h,
          dropBetSide: drop?.betSide,
          bet365: b365,
          winamax: wmx,
          mercado,
          betSide,
          ctx,
          nextMatchDate: evento.date,
        });

        const pick = {
          mercado,
          linea: vb.market?.hdp || null,
          betSide,
          seleccion: formatFootballSelection(mercado, betSide, vb.market?.hdp, evento),
          bookSearchLabel: formatFootballBookSearchLabel(mercado, betSide, vb.market?.hdp, evento),
          ev,
          evPercent,
          confianza: sc.total,
          scores: sc.scores,
          bet365_odds: sc.bet365Odds,
          winamax_odds: sc.winamaxOdds,
          mejor_cuota: sc.bestOdds,
          valueBook: sc.valueBook,
          gap: sc.gap,
          drop_12h: drop12h,
          senalDoble: sc.senalDoble,
          rationale: buildFootballPickNarrative(mercado, evento, ctx, evPercent || "N/D", sc.total),
          supportLabel: buildFootballSupportLabel(ctx, mercado),
          source: baseCtx.__source || "priors",
          href: vb.bookmakerOdds?.href || null,
        };

        if (Number.isFinite(ev) && esVerde(ev, sc.bestOdds, sc.total, sc.bajasTitulares, sc.senalDoble, mercado, ctx)) {
          pick.estado = "verde";
          pick.valueBetApplied = true;
          picks.push(pick);
        } else if (Number.isFinite(ev) && esAmarillo(ev, sc.bestOdds, sc.total, sc.bajasTitulares, sc.senalDoble, mercado, ctx)) {
          pick.estado = "amarillo";
          picks.push(pick);
        } else if (sc.total >= FOOTBALL_DISPLAY_CONF_MIN && hasRealDataForPick(ctx)) {
          sin_valor.push({
            mercado,
            market: mercado,
            linea: vb.market?.hdp || null,
            betSide,
            seleccion: formatFootballSelection(mercado, betSide, vb.market?.hdp, evento),
            selection: formatFootballSelection(mercado, betSide, vb.market?.hdp, evento),
            pick: formatFootballSelection(mercado, betSide, vb.market?.hdp, evento),
            bookSearchLabel: formatFootballBookSearchLabel(mercado, betSide, vb.market?.hdp, evento),
            ev,
            evPercent,
            confianza: sc.total,
            scores: sc.scores,
            bet365_odds: sc.bet365Odds || null,
            winamax_odds: sc.winamaxOdds || null,
            mejor_cuota: sc.bestOdds || null,
            bestOdds: sc.bestOdds || null,
            valueBook: sc.valueBook,
            gap: sc.gap,
            drop_12h: drop12h,
            drop12h,
            senalDoble: sc.senalDoble,
            estado: "sin_valor",
            valueLabel: "Sin valor",
            verdictLabel: Number.isFinite(ev)
              ? `Sin valor por EV ${(ev * 100).toFixed(1)}% y confianza ${sc.total}.`
              : "Sin cuota real: EV no calculable.",
            rationale: buildFootballPickNarrative(mercado, evento, ctx, evPercent || "N/D", sc.total),
            supportLabel: buildFootballSupportLabel(ctx, mercado),
            source: baseCtx.__source || "priors",
            href: vb.bookmakerOdds?.href || null,
          });
        }
      }
    }

    picks.sort(compareFootballPicksForValue);

    if (!picks.length && !sin_valor.length) {
      const modelResult = buildFootballModelLeanFromOdds(evento, odds, baseCtx, insight);
      picks.push(...modelResult.picks);
      sin_valor.push(...modelResult.sin_valor);
    }

    return {
      eventId: evento.id,
      espnEventId: insight?.eventId || null,
      leagueSlug: insight?.leagueSlug || null,
      home: evento.home,
      away: evento.away,
      liga: evento.league?.name || "",
      hora: evento.date,
      source: baseCtx.__source || "priors",
      stadium: insight?.stadium || null,
      referee: insight?.referee || null,
      lineups: insight?.lineups || null,
      homeTeam: insight?.homeTeam || null,
      awayTeam: insight?.awayTeam || null,
      matchModel: insight?.matchModel || null,
      h2h: insight?.h2h || null,
      mlOdds: extractMlOddsSnapshot(odds),
      footballCtx: extractFootballCtxSnapshot(baseCtx),
      oddsDrop: drop
        ? {
            drop12h: drop?.odds?.drop?.["12h"] || 0,
            betSide: drop?.betSide || null,
            market: drop?.market?.name || null,
          }
        : null,
      picks: picks.slice(0, 2),
      sin_valor,
      _proInput: { evento, odds, baseCtx, insight, mlOdds: extractMlOddsSnapshot(odds), drop, picks: picks.slice(0, 2), sin_valor },
    };
  });

  const partidos = await Promise.all(
    partidosRaw.map(async (partido) => {
      const input = partido._proInput;
      if (!input) return partido;
      try {
        const pro = await enrichFootballPartidoWithPro(input);
        const { _proInput, ...rest } = partido;
        const proPicks = Array.isArray(pro.picks) ? pro.picks : [];
        const proSinValor = Array.isArray(pro.sin_valor) ? pro.sin_valor : [];
        const bettablePicks = proPicks.filter((pick) => pick?.estado === "verde" || pick?.estado === "amarillo");
        const downgradedPicks = proPicks.filter((pick) => pick?.estado !== "verde" && pick?.estado !== "amarillo");
        return {
          ...rest,
          picks: bettablePicks,
          sin_valor: [...proSinValor, ...downgradedPicks],
          lineMovementInput: pro.lineMovementInput,
          lineMovementMl: pro.lineMovementMl,
        };
      } catch (err) {
        console.warn(`[football] pro scoring ${partido.eventId}:`, err.message);
        const { _proInput, ...rest } = partido;
        return rest;
      }
    })
  );

  const allValuePicks = partidos.flatMap((partido) =>
    [...(partido.picks || []), ...(partido.sin_valor || [])]
      .filter((pick) => pick.estado === "verde" || isFootballValuePick(pick))
      .map((pick) => ({
        ...pick,
        eventId: partido.eventId,
        partido: `${partido.home} vs ${partido.away}`,
        sport: "football",
        matchId: partido.eventId,
      }))
  );

  const top5 = allValuePicks
    .sort(compareFootballPicksForValue)
    .reduce((acc, pick) => {
      if (acc.filter((entry) => entry.eventId === pick.eventId).length < 2) acc.push(pick);
      return acc;
    }, [])
    .slice(0, 5)
    .map((pick, index) => ({ posicion: index + 1, ...pick }));

  const combinadas = buildValueParlays(allValuePicks).slice(0, 3);

  return {
    dataAvailable: true,
    date: hoy,
    hora_analisis: new Date().toLocaleTimeString("es-ES", { timeZone: "Europe/Madrid" }),
    partidos_analizados: eventosHoy.length,
    picks_verdes: partidos.flatMap((partido) => partido.picks.filter((pick) => pick.estado === "verde")).length,
    picks_amarillos: partidos.flatMap((partido) => partido.picks.filter((pick) => pick.estado === "amarillo")).length,
    picks_value: allValuePicks.length,
    partidos,
    top5_jornada: top5,
    combinadas_top: combinadas,
  };
}

function adaptPickForUi(pick, partido) {
  const type = mercadoToType(pick.mercado);
  const valueReady = isFootballValuePick(pick);
  const passesMinConfidence = footballPickConfidence(pick) >= FOOTBALL_RECOMMENDATION_CONF_MIN;
  const ready = (pick.estado === "verde" || valueReady) && passesMinConfidence;
  const isModel = pick.estado === "modelo" || pick.estado === "sin_valor";
  const odds = footballPickOdds(pick);
  const confidence = footballPickConfidence(pick);
  const modelConfidence = readFiniteNumber(pick.modelConfidence, pick.confidence, pick.confianza_final, pick.confianza) ?? confidence;
  const ev = footballPickEv(pick);
  const evPercent = pick.evPercent || (ev != null ? `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%` : null);
  const score = readFiniteNumber(pick.score, pick.score_final);
  return {
    id: `${partido.eventId}-${pick.mercado}-${pick.betSide}-${pick.linea || "main"}`,
    type,
    category: pick.mercado,
    matchId: partido.eventId,
    matchLabel: `${partido.home} vs ${partido.away}`,
    selection: pick.seleccion,
    market: pick.mercado,
    odds,
    bestOdds: odds,
    bet365Odds: pick.bet365_odds,
    winamaxOdds: pick.winamax_odds,
    confidence,
    modelConfidence,
    ev,
    evPercent,
    readyToBet: ready,
    bettable: ready,
    safeForCombo: (pick.estado === "amarillo" && passesMinConfidence) || ready,
    verdict: ready ? "valid" : pick.estado === "amarillo" || isModel ? "lean" : "avoid",
    verdictLabel: pick.estado === "verde"
      ? "Apuesta repetitiva validada"
      : valueReady
        ? "Pick value por EV positivo"
      : isModel
        ? "Lectura de modelo sin value-bet"
        : "Patron fuerte del partido",
    valueBook: pick.valueBook,
    valueLabel: ev >= 0.1 ? "Alto valor" : ev >= 0.05 ? "Valor moderado" : ev >= FOOTBALL_VALUE_EV_MIN ? "Valor esperado positivo" : "Sin valor",
    oddsGap: pick.gap,
    drop12h: pick.drop_12h,
    senalDoble: pick.senalDoble,
    bookSearchLabel: pick.bookSearchLabel || "",
    displayState: ready ? "buena" : pick.estado === "amarillo" ? "alternativa" : isModel ? "alternativa" : "opaca",
    primaryMarket: ["ML", "Double Chance", "Totals"].includes(pick.mercado),
    rationale: pick.rationale || `EV ${evPercent || "N/D"} con confianza ${confidence} en ${pick.mercado}.`,
    supportLabel: pick.senalDoble ? "Senal doble: value-bet + dropping odds" : (pick.supportLabel || `Gap ${pick.gap}`),
    sport: "football",
    tournament: partido.liga,
    source: pick.source || partido.source || "priors",
    estado: pick.estado,
    scoreFactors: pick.scores || null,
    scheduledAt: partido.hora,
    color: pick.color || (pick.estado === "verde" ? "verde" : valueReady || pick.estado === "amarillo" ? "amarillo" : "gris"),
    score,
    score_final: score,
    edge: footballPickEdge(pick),
    edgePercent: pick.edgePercent ?? null,
    prob_model: pick.prob_model ?? null,
    prob_market: pick.prob_market ?? null,
    line_movement: pick.line_movement ?? partido.lineMovementMl ?? null,
    lineTrapActive: pick.lineTrapActive ?? false,
    lineTrapDetected: pick.lineTrapDetected ?? false,
    valueModeApplied: Boolean(valueReady || pick.valueModeApplied),
    valueBettable: Boolean(valueReady || pick.valueBettable),
    proBettable: Boolean(pick.proBettable),
    lineMovementNote: pick.lineMovementNote ?? null,
    pct_public_home: pick.pct_public_home ?? partido.lineMovementInput?.pct_tickets_home ?? null,
    pct_public_away: pick.pct_public_away ?? partido.lineMovementInput?.pct_tickets_away ?? null,
    betSide: pick.betSide,
  };
}

function adaptPartidoForUi(partido) {
  const recommendations = [
    ...partido.picks.map((pick) => adaptPickForUi(pick, partido)),
    ...(partido.sin_valor || []).map((pick) => adaptPickForUi(pick, partido)),
  ].sort(compareFootballPicksForValue).slice(0, 6);
  const bestRecommendation = recommendations[0] || null;
  return {
    id: String(partido.eventId),
    espnEventId: partido.espnEventId || null,
    leagueSlug: partido.leagueSlug || null,
    sport: "futbol",
    status: "scheduled",
    scheduledAt: partido.hora,
    date: partido.hora,
    league: partido.liga,
    stadium: partido.stadium || "Stadium TBD",
    referee: partido.referee || null,
    h2h: partido.h2h || null,
    homeTeam: partido.homeTeam || {
      name: partido.home,
      record: { label: "N/D", pointsPerGame: 0 },
      form: { sequence: "N/D" },
      recent: { goalsForAvg: 0, goalsAgainstAvg: 0, teamScoreRate: 0, bttsRate: 0, pointsPerGame: 0, matches: [] },
      season: { goalsPerGame: 0, goalDiffPerGame: 0, totalGoals: 0 },
      leaders: { shots: null, goals: null },
    },
    awayTeam: partido.awayTeam || {
      name: partido.away,
      record: { label: "N/D", pointsPerGame: 0 },
      form: { sequence: "N/D" },
      recent: { goalsForAvg: 0, goalsAgainstAvg: 0, teamScoreRate: 0, bttsRate: 0, pointsPerGame: 0, matches: [] },
      season: { goalsPerGame: 0, goalDiffPerGame: 0, totalGoals: 0 },
      leaders: { shots: null, goals: null },
    },
    lineups: partido.lineups || null,
    recommendations,
    bestRecommendation,
    lineMovementInput: partido.lineMovementInput || null,
    lineMovementMl: partido.lineMovementMl || null,
    matchModel: partido.matchModel || { expectedGoals: 0, expectedCorners: 0, expectedHomeShots: 0, expectedAwayShots: 0 },
    marketBooks: {},
    dataSource: partido.source || "priors",
  };
}

function adaptParlayForUi(parlay) {
  return {
    id: parlay.id,
    selections: parlay.selections || parlay.legs || [],
    totalOdds: parlay.totalOdds || Number.parseFloat(parlay.combinedOdds),
    comboScore: parlay.comboScore,
    combinedPattern: 0.65,
    combinedEV: parlay.combinedEV,
    combinedEVPercent: parlay.combinedEVPercent,
    rationale: parlay.rationale,
    isCrossSport: parlay.isCrossSport,
    valueBook: parlay.valueBook,
  };
}

function buildFootballUnavailableAnalysis(date, reason) {
  return {
    app: "DANNY PICK",
    module: "Football Desk",
    sport: "futbol",
    date,
    generatedAt: new Date().toISOString(),
    dataAvailable: false,
    unavailableReason: reason,
    reason,
    methodology: {
      principle: "Value-bets y dropping-odds de Odds-API.io con scoring de 10 factores.",
      scoring: "EV real de /value-bets, sin datos inventados.",
      note: reason,
    },
    providers: [
      { id: "odds", name: "Odds-API.io", status: process.env.ODDS_API_IO_KEY ? "configured" : "missing-credentials" },
    ],
    runtime: { dataProvider: "odds-api-io", oddsProvider: "odds-api-io", unavailableReason: reason },
    coverage: { schedule: 0, odds: 0 },
    stalenessMinutes: { schedule: 999, odds: 999, form: 999 },
    slateSummary: {
      matchesToday: 0,
      matchesBettable: 0,
      matchesAnalyzed: 0,
      readyRecommendations: 0,
      playerPropsMatched: 0,
    },
    picks: [],
    trendPicks: [],
    goalsPicks: [],
    cornersPicks: [],
    shotsPicks: [],
    resultPicks: [],
    playerProps: [],
    parlays: [],
    matches: [],
    partidos: [],
    top5_jornada: [],
    combinadas_top: [],
    riskNotes: [reason],
  };
}

export async function buildFootballAnalysis(date) {
  try {
    const result = await analyzeFootballSlate(date);
    const apiSportsEnabled = Boolean(_apiSportsCfg?.enabled && _apiSportsCfg?.apiKey);

    if (!result.dataAvailable) {
      return buildFootballUnavailableAnalysis(date, result.reason || "Datos no disponibles");
    }

  const quinielaRows = getCachedOfficialQuinielaRows();
  const deskPartidos = filterPartidosExcludingQuiniela(result.partidos, quinielaRows);
  const deskTop5 = filterPicksExcludingQuiniela(result.top5_jornada, quinielaRows);
  const deskCombinadas = (result.combinadas_top || [])
    .map((combo) => ({
      ...combo,
      legs: (combo.legs || []).filter((leg) => {
        const label = String(leg?.partido || leg?.event || "");
        const match = label.match(/^(.+?)\s+vs\s+(.+)$/i);
        if (!match) return true;
        return !isQuinielaOfficialMatch(match[1].trim(), match[2].trim(), quinielaRows);
      }),
    }))
    .filter((combo) => (combo.legs || []).length >= 2);

  const matches = deskPartidos.map(adaptPartidoForUi);
  const upcomingMatches = filterUpcomingDayMatches(matches, "futbol", date);
  const bettableMatches = filterBettableMatches(upcomingMatches, "futbol", date);
  const allPicks = upcomingMatches.flatMap((match) => match.recommendations);
  const picks = allPicks
    .filter((pick) => pick.bettable)
    .sort(compareFootballPicksForValue)
    .slice(0, 8);
  const trendPicks = allPicks
    .filter((pick) => !pick.bettable && pick.verdict !== "avoid")
    .sort(compareFootballPicksForValue)
    .slice(0, 10);
  const parlays = (result.combinadas_top || []).map(adaptParlayForUi);
  const lineupsCoveredCount = deskPartidos.filter((partido) => Boolean(partido.lineups?.available)).length;
  const lineupsConfirmedCount = deskPartidos.filter((partido) => Boolean(partido.lineups?.bothConfirmed)).length;
  const lineupCoverageRatio = deskPartidos.length ? round(lineupsCoveredCount / deskPartidos.length, 2) : 0;
  const lineupFreshness = apiSportsEnabled ? Math.max(5, Number(_apiSportsCfg.refreshMinutes || 25)) : 999;

  persistAnalyzerPicksFromMatches(upcomingMatches, "football", mapFootballPickToBacktestRecord).catch(
    (err) => {
      console.warn("[backtesting] Football persist:", err.message);
    }
  );

  return {
    app: "DANNY PICK",
    module: "Football Desk",
    sport: "futbol",
    date: result.date,
    generatedAt: new Date().toISOString(),
    dataAvailable: true,
    hora_analisis: result.hora_analisis,
    partidos_analizados: deskPartidos.length,
    picks_verdes: deskPartidos.reduce((acc, partido) => acc + partido.picks.filter((pick) => pick.estado === "verde").length, 0),
    picks_amarillos: deskPartidos.reduce((acc, partido) => acc + partido.picks.filter((pick) => pick.estado === "amarillo").length, 0),
    picks_value: picks.length,
    partidos: deskPartidos,
    top5_jornada: deskTop5,
    combinadas_top: deskCombinadas,
    methodology: {
      principle: "EV real de /value-bets y dropping-odds cruzado con contexto de partido desde ESPN Site API y snapshots conservadores de API-Sports.",
      scoring: isFootballValueMode()
        ? `Modo value: picks verdes pro + amarillos con EV >= ${(FOOTBALL_VALUE_EV_MIN * 100).toFixed(1)}%, cuota en rango y confianza >= ${FOOTBALL_VALUE_CONF_MIN}.`
        : "Modo pro: solo picks verdes con EV >= 5%, cuota en rango y confianza >= 60, o >= 56 con senal doble.",
      note: apiSportsEnabled
        ? "Stack activo: Odds-API.io value-bets + dropping-odds + line movement (OddsHarvester) + scoring pro + odds/multi Bet365/Winamax FR + ESPN publico para forma/H2H/shots/corners + API-Sports futbol para snapshots de alineaciones cada 25 min."
        : "Stack activo: Odds-API.io value-bets + dropping-odds + line movement (OddsHarvester) + scoring pro + odds/multi Bet365/Winamax FR + ESPN publico para forma/H2H/shots/corners.",
    },
    providers: [
      {
        id: "odds",
        name: "Odds-API.io",
        status: "configured",
        purpose: "Value-bets, dropping-odds y cuotas multi mercado.",
        docs: "https://docs.odds-api.io/",
      },
      {
        id: "espn-site",
        name: "ESPN Site API",
        status: "configured",
        purpose: "Forma reciente, H2H, standings, tiros, corners y tarjetas desde resúmenes publicos.",
        docs: "https://site.api.espn.com/",
      },
      {
        id: "api-sports-football",
        name: "API-Sports Football",
        status: apiSportsEnabled ? "configured" : "missing-credentials",
        purpose: "Snapshots conservadores de fixture y alineaciones para no consumir el plan gratuito en exceso.",
        docs: "https://www.api-football.com/documentation-v3",
      },
    ],
    runtime: {
      dataProvider: "odds-api-io",
      oddsProvider: "odds-api-io",
      contextProvider: "espn-site-api",
      supplementalProvider: apiSportsEnabled ? "api-sports-football" : null,
      maxMatches: FOOTBALL_MAX_MATCH,
      pickMode: isFootballValueMode() ? "value" : "pro",
      valueEvMin: FOOTBALL_VALUE_EV_MIN,
      valueConfidenceMin: FOOTBALL_VALUE_CONF_MIN,
    },
    coverage: {
      schedule: 1,
      odds: picks.length ? 1 : 0.5,
      recentForm: 0.82,
      goals: 0.8,
      corners: 0.72,
      shots: 0.7,
      lineups: lineupCoverageRatio,
      playerProps: 0,
    },
    stalenessMinutes: { schedule: 10, odds: 10, form: 30, lineups: lineupFreshness },
    slateSummary: {
      matchesToday: upcomingMatches.length,
      matchesBettable: bettableMatches.length,
      matchesAnalyzed: deskPartidos.length,
      readyRecommendations: picks.length,
      lineupsCovered: lineupsCoveredCount,
      lineupsConfirmed: lineupsConfirmedCount,
      playerPropsMatched: 0,
      cornersMarketsMatched: deskPartidos.filter((partido) =>
        partido.picks.some((pick) => String(pick.mercado).includes("Corners"))
      ).length,
      shotsMarketsMatched: 0,
    },
    bestPick: picks[0] || trendPicks[0] || null,
    picks,
    trendPicks,
    goalsPicks: picks.filter((pick) => pick.type === "goals" || pick.type === "team-goals"),
    cornersPicks: picks.filter((pick) => pick.type === "corners"),
    shotsPicks: [],
    resultPicks: picks.filter((pick) => pick.type === "result"),
    playerProps: [],
    parlays,
    matches: upcomingMatches,
    bettableMatches,
    riskNotes: [
      "EV proviene de /value-bets de Odds-API.io, no calculado localmente.",
      "Sin mock: si la API falla, dataAvailable=false.",
      "Corners y bookings dependen de disponibilidad en value-bets del dia.",
      "API-Sports gratuito no cubre tennis en esta integracion; el refuerzo activo se aplica solo a futbol.",
      ...(quinielaRows.length
        ? ["Partidos del boleto oficial de Quiniela se excluyen del desk de fútbol; pronóstico 1X2 solo en módulo Quiniela."]
        : []),
    ],
  };
  } catch (error) {
    return buildFootballUnavailableAnalysis(date, error?.message || "Error analizando futbol");
  }
}
