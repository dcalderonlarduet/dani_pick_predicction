import { clamp, round } from "../utils/math.js";
import { canonicalName } from "./shared/tennis-normalizers.js";
import { fetchJson } from "./shared/http.js";

const ESPN_SOCCER_BASE_URL = process.env.ESPN_SOCCER_BASE_URL || "https://site.api.espn.com/apis/site/v2/sports/soccer";
const SUMMARY_CACHE = new Map();
const SCOREBOARD_CACHE = new Map();

const LEAGUE_MAPPINGS = [
  { test: /(england-premier-league|premier league|eng\.1)/i, slug: "eng.1" },
  { test: /(spain-laliga|laliga|la liga|esp\.1)/i, slug: "esp.1" },
  { test: /(spain-segunda|segunda division|segunda|esp\.2)/i, slug: "esp.2" },
  { test: /(germany-bundesliga|bundesliga|ger\.1)/i, slug: "ger.1" },
  { test: /(italy-serie-a|serie a|ita\.1)/i, slug: "ita.1" },
  { test: /(france-ligue-1|ligue 1|fra\.1)/i, slug: "fra.1" },
  { test: /(uefa-champions-league|champions league|uefa champions|uefa\.champions)/i, slug: "uefa.champions" },
  { test: /(uefa-europa-league|europa league|uefa europa|uefa\.europa)/i, slug: "uefa.europa" },
  { test: /(uefa-conference-league|conference league|uefa conference)/i, slug: "uefa.europa.conf" },
  { test: /(fa cup|eng\.fa)/i, slug: "eng.fa" },
  { test: /(copa del rey)/i, slug: "esp.copa_del_rey" },
  { test: /(coppa italia)/i, slug: "ita.coppa_italia" },
  { test: /(dfb pokal)/i, slug: "ger.dfb_pokal" },
  { test: /(coupe de france)/i, slug: "fra.coupe_de_france" },
];

// Ligas españolas a intentar para enriquecer filas de la quiniela sin match
const SPAIN_QUINIELA_SLUGS = ["esp.1", "esp.2", "esp.copa_del_rey"];

function shiftDateStr(dateStr, days) {
  try {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  } catch {
    return dateStr;
  }
}

function normalizeTeamName(value) {
  return canonicalName(value)
    .replace(/\b(fc|cf|ac|afc|club|deportivo|club de futbol|club de futbol s a d|sad|ud|cd)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toEspnDate(date) {
  return String(date || "").replaceAll("-", "");
}

function resolveLeagueSlugFromText(...values) {
  const haystack = values.filter(Boolean).join(" ");
  for (const entry of LEAGUE_MAPPINGS) {
    if (entry.test.test(haystack)) return entry.slug;
  }
  return null;
}

function resolveLeagueSlugFromEvent(evento) {
  return resolveLeagueSlugFromText(evento?.league?.slug || "", evento?.league?.name || "");
}

function createOrderedKey(home, away) {
  return `${normalizeTeamName(home)}::${normalizeTeamName(away)}`;
}

function createTokenSet(value) {
  return new Set(normalizeTeamName(value).split(" ").filter(Boolean));
}

function overlapScore(left, right) {
  const leftTokens = createTokenSet(left);
  const rightTokens = createTokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function extractCompetitors(event) {
  if (Array.isArray(event?.competitions?.[0]?.competitors)) {
    return event.competitions[0].competitors;
  }
  return [];
}

function extractScoreboardTeams(event) {
  const competitors = extractCompetitors(event);
  if (competitors.length < 2) return null;
  const home = competitors.find((item) => item?.homeAway === "home") || competitors[0];
  const away = competitors.find((item) => item?.homeAway === "away") || competitors[1];
  const homeName = home?.team?.displayName || home?.displayName || null;
  const awayName = away?.team?.displayName || away?.displayName || null;
  const homeId = home?.team?.id || home?.id || null;
  const awayId = away?.team?.id || away?.id || null;
  if (!homeName || !awayName) return null;
  return {
    eventId: String(event?.id || ""),
    homeName,
    awayName,
    homeId: homeId ? String(homeId) : null,
    awayId: awayId ? String(awayId) : null,
  };
}

function scoreboardMatchScore(event, home, away) {
  const parsed = extractScoreboardTeams(event);
  if (!parsed) return 0;
  const exactKey = createOrderedKey(home, away);
  if (createOrderedKey(parsed.homeName, parsed.awayName) === exactKey) return 1;
  return (overlapScore(home, parsed.homeName) + overlapScore(away, parsed.awayName)) / 2;
}

async function fetchScoreboard(leagueSlug, date) {
  const cacheKey = `${leagueSlug}|${date}`;
  if (SCOREBOARD_CACHE.has(cacheKey)) {
    return SCOREBOARD_CACHE.get(cacheKey);
  }

  const promise = fetchJson(`${ESPN_SOCCER_BASE_URL}/${leagueSlug}/scoreboard?dates=${toEspnDate(date)}`, {
    provider: `espn-soccer:${leagueSlug}:scoreboard`,
    timeoutMs: 15000,
  }).catch(() => null);

  SCOREBOARD_CACHE.set(cacheKey, promise);
  return promise;
}

async function fetchSummary(leagueSlug, eventId) {
  const cacheKey = `${leagueSlug}|${eventId}`;
  if (SUMMARY_CACHE.has(cacheKey)) {
    return SUMMARY_CACHE.get(cacheKey);
  }

  const promise = fetchJson(`${ESPN_SOCCER_BASE_URL}/${leagueSlug}/summary?event=${eventId}`, {
    provider: `espn-soccer:${leagueSlug}:summary`,
    timeoutMs: 15000,
  }).catch(() => null);

  SUMMARY_CACHE.set(cacheKey, promise);
  return promise;
}

function extractStatValue(stats = [], name) {
  const row = stats.find((entry) => entry?.name === name);
  if (!row) return null;
  const raw = row.displayValue ?? row.value ?? null;
  if (raw == null) return null;
  const numeric = Number.parseFloat(String(raw).replace("%", "").replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function extractTeamStatsFromSummary(summary, teamId) {
  const teams = Array.isArray(summary?.boxscore?.teams) ? summary.boxscore.teams : [];
  return teams.find((entry) => String(entry?.team?.id || "") === String(teamId || "")) || null;
}

function extractStandingsMap(summary) {
  const standingsBlock = Array.isArray(summary?.standings) ? summary.standings[0] : null;
  const entries = Array.isArray(standingsBlock?.groups?.[0]?.standings?.entries)
    ? standingsBlock.groups[0].standings.entries
    : Array.isArray(standingsBlock?.entries)
      ? standingsBlock.entries
      : [];
  const map = new Map();
  for (const entry of entries) {
    const teamId = entry?.id || entry?.team?.id || entry?.uid || null;
    if (!teamId) continue;
    const rankStat = Array.isArray(entry?.stats) ? entry.stats.find((item) => item?.name === "rank") : null;
    map.set(String(teamId), {
      rank: rankStat?.value != null ? Number(rankStat.value) : null,
      totalTeams: entries.length || null,
      overall: Array.isArray(entry?.stats) ? entry.stats.find((item) => item?.name === "overall" || item?.id === "0")?.summary || null : null,
    });
  }
  return map;
}

function buildFormSequence(events = []) {
  return events
    .map((event) => String(event?.gameResult || "").toUpperCase())
    .filter((value) => value === "W" || value === "D" || value === "L")
    .join("");
}

function parseRecentEventScore(formEvent, teamId) {
  const homeId = String(formEvent?.homeTeamId || "");
  const awayId = String(formEvent?.awayTeamId || "");
  const homeScore = Number.parseFloat(String(formEvent?.homeTeamScore || "").replace(",", "."));
  const awayScore = Number.parseFloat(String(formEvent?.awayTeamScore || "").replace(",", "."));
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  const isHome = homeId === String(teamId || "");
  return {
    isHome,
    goalsFor: isHome ? homeScore : awayScore,
    goalsAgainst: isHome ? awayScore : homeScore,
    totalGoals: homeScore + awayScore,
    result: String(formEvent?.gameResult || "").toUpperCase() || null,
    eventId: String(formEvent?.id || ""),
    opponent: formEvent?.opponent?.displayName || null,
    competitionName: formEvent?.competitionName || formEvent?.leagueName || "",
    gameDate: formEvent?.gameDate || null,
  };
}

function buildRecentEventFetchList(summary, limitPerTeam = 3) {
  const formEntries = Array.isArray(summary?.boxscore?.form) ? summary.boxscore.form : [];
  const result = [];
  for (const entry of formEntries) {
    const events = Array.isArray(entry?.events) ? entry.events.slice(0, limitPerTeam) : [];
    events.forEach((event) => {
      if (!event?.id) return;
      result.push({
        eventId: String(event.id),
        leagueSlug:
          resolveLeagueSlugFromText(event?.leagueAbbreviation || "", event?.leagueName || "", event?.competitionName || "") ||
          resolveLeagueSlugFromText(summary?.header?.league?.slug || "", summary?.header?.league?.name || ""),
      });
    });
  }
  return result;
}

function buildRecentMatchSamples(formEvents, recentSummaries, teamId) {
  const samples = [];
  for (const formEvent of formEvents || []) {
    const score = parseRecentEventScore(formEvent, teamId);
    if (!score) continue;
    const summary = recentSummaries.get(String(formEvent?.id || ""));
    const teamStats = summary ? extractTeamStatsFromSummary(summary, teamId) : null;
    const opponentStats = summary && Array.isArray(summary?.boxscore?.teams)
      ? summary.boxscore.teams.find((entry) => String(entry?.team?.id || "") !== String(teamId || ""))
      : null;

    samples.push({
      ...score,
      shots: extractStatValue(teamStats?.statistics, "totalShots"),
      shotsOnTarget: extractStatValue(teamStats?.statistics, "shotsOnTarget"),
      corners: extractStatValue(teamStats?.statistics, "wonCorners"),
      yellowCards: extractStatValue(teamStats?.statistics, "yellowCards"),
      redCards: extractStatValue(teamStats?.statistics, "redCards"),
      shotsAgainst: extractStatValue(opponentStats?.statistics, "totalShots"),
      shotsOnTargetAgainst: extractStatValue(opponentStats?.statistics, "shotsOnTarget"),
      cornersAgainst: extractStatValue(opponentStats?.statistics, "wonCorners"),
      yellowCardsAgainst: extractStatValue(opponentStats?.statistics, "yellowCards"),
      redCardsAgainst: extractStatValue(opponentStats?.statistics, "redCards"),
    });
  }
  return samples;
}

function averageOf(samples, field) {
  const values = samples.map((entry) => entry?.[field]).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildRecentTeamStats(formEntry, recentSummaries, teamId) {
  const events = Array.isArray(formEntry?.events) ? formEntry.events.slice(0, 5) : [];
  const samples = buildRecentMatchSamples(events, recentSummaries, teamId);
  const points = samples.reduce((sum, item) => sum + (item.result === "W" ? 3 : item.result === "D" ? 1 : 0), 0);
  const goalsForAvg = averageOf(samples, "goalsFor");
  const goalsAgainstAvg = averageOf(samples, "goalsAgainst");
  const totalGoalsAvg = averageOf(samples, "totalGoals");
  const cornersForAvg = averageOf(samples, "corners");
  const cornersAgainstAvg = averageOf(samples, "cornersAgainst");
  const shotsForAvg = averageOf(samples, "shots");
  const shotsAgainstAvg = averageOf(samples, "shotsAgainst");
  const shotsOnTargetAvg = averageOf(samples, "shotsOnTarget");
  const shotsOnTargetAgainstAvg = averageOf(samples, "shotsOnTargetAgainst");
  const cardsForAvg =
    averageOf(samples, "yellowCards") != null || averageOf(samples, "redCards") != null
      ? (averageOf(samples, "yellowCards") || 0) + (averageOf(samples, "redCards") || 0) * 2
      : null;
  const cardsAgainstAvg =
    averageOf(samples, "yellowCardsAgainst") != null || averageOf(samples, "redCardsAgainst") != null
      ? (averageOf(samples, "yellowCardsAgainst") || 0) + (averageOf(samples, "redCardsAgainst") || 0) * 2
      : null;
  const bttsCount = samples.filter((item) => item.goalsFor > 0 && item.goalsAgainst > 0).length;
  const over25Count = samples.filter((item) => item.totalGoals > 2.5).length;
  const scoreCount = samples.filter((item) => item.goalsFor > 0).length;
  const winCount = samples.filter((item) => item.result === "W").length;
  const drawCount = samples.filter((item) => item.result === "D").length;
  const lossCount = samples.filter((item) => item.result === "L").length;

  return {
    sequence: buildFormSequence(events),
    matches: samples.map((item) => ({
      result: item.result,
      goalsFor: item.goalsFor,
      goalsAgainst: item.goalsAgainst,
      opponent: item.opponent,
      shots: item.shots,
      shotsOnTarget: item.shotsOnTarget,
      corners: item.corners,
      cards: item.yellowCards != null || item.redCards != null ? (item.yellowCards || 0) + (item.redCards || 0) * 2 : null,
      competitionName: item.competitionName,
      gameDate: item.gameDate,
    })),
    goalsForAvg: goalsForAvg != null ? round(goalsForAvg, 2) : null,
    goalsAgainstAvg: goalsAgainstAvg != null ? round(goalsAgainstAvg, 2) : null,
    totalGoalsAvg: totalGoalsAvg != null ? round(totalGoalsAvg, 2) : null,
    teamScoreRate: samples.length ? round(scoreCount / samples.length, 3) : null,
    bttsRate: samples.length ? round(bttsCount / samples.length, 3) : null,
    over25Rate: samples.length ? round(over25Count / samples.length, 3) : null,
    pointsPerGame: samples.length ? round(points / samples.length, 2) : null,
    winRate: samples.length ? round(winCount / samples.length, 3) : null,
    drawRate: samples.length ? round(drawCount / samples.length, 3) : null,
    lossRate: samples.length ? round(lossCount / samples.length, 3) : null,
    shotsForAvg: shotsForAvg != null ? round(shotsForAvg, 2) : null,
    shotsAgainstAvg: shotsAgainstAvg != null ? round(shotsAgainstAvg, 2) : null,
    shotsOnTargetAvg: shotsOnTargetAvg != null ? round(shotsOnTargetAvg, 2) : null,
    shotsOnTargetAgainstAvg: shotsOnTargetAgainstAvg != null ? round(shotsOnTargetAgainstAvg, 2) : null,
    cornersForAvg: cornersForAvg != null ? round(cornersForAvg, 2) : null,
    cornersAgainstAvg: cornersAgainstAvg != null ? round(cornersAgainstAvg, 2) : null,
    cardsForAvg: cardsForAvg != null ? round(cardsForAvg, 2) : null,
    cardsAgainstAvg: cardsAgainstAvg != null ? round(cardsAgainstAvg, 2) : null,
  };
}

function buildH2HStats(summary, homeTeamId, awayTeamId, homeName, awayName) {
  const rawEntries = Array.isArray(summary?.headToHeadGames) ? summary.headToHeadGames : [];
  const events = Array.isArray(rawEntries[0]?.events) ? rawEntries[0].events : [];
  if (!events.length) {
    return {
      total: 0,
      dominantMarketLabel: null,
      overRate: null,
      bttsRate: null,
      avgGoals: null,
    };
  }

  let homeWins = 0;
  let awayWins = 0;
  let draws = 0;
  let over25 = 0;
  let btts = 0;
  let totalGoals = 0;

  events.forEach((event) => {
    const homeScore = Number.parseFloat(String(event?.homeTeamScore || "").replace(",", "."));
    const awayScore = Number.parseFloat(String(event?.awayTeamScore || "").replace(",", "."));
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
    totalGoals += homeScore + awayScore;
    if (homeScore > awayScore) {
      if (String(event?.homeTeamId || "") === String(homeTeamId || "")) homeWins += 1;
      else if (String(event?.homeTeamId || "") === String(awayTeamId || "")) awayWins += 1;
    } else if (awayScore > homeScore) {
      if (String(event?.awayTeamId || "") === String(homeTeamId || "")) homeWins += 1;
      else if (String(event?.awayTeamId || "") === String(awayTeamId || "")) awayWins += 1;
    } else {
      draws += 1;
    }
    if (homeScore + awayScore > 2.5) over25 += 1;
    if (homeScore > 0 && awayScore > 0) btts += 1;
  });

  const total = homeWins + awayWins + draws;
  const overRate = total ? over25 / total : null;
  const bttsRate = total ? btts / total : null;
  const avgGoals = total ? totalGoals / total : null;
  const homeRate = total ? homeWins / total : null;
  const awayRate = total ? awayWins / total : null;
  const drawRate = total ? draws / total : null;

  let dominantMarketLabel = null;
  if (overRate != null && overRate >= 0.6) dominantMarketLabel = `H2H: ${over25}/${total} over 2.5`;
  else if (bttsRate != null && bttsRate >= 0.6) dominantMarketLabel = `H2H: ${btts}/${total} BTTS`;
  else if (homeRate != null && homeRate >= 0.6) dominantMarketLabel = `H2H: ${homeName} domina ${homeWins}/${total}`;
  else if (awayRate != null && awayRate >= 0.6) dominantMarketLabel = `H2H: ${awayName} domina ${awayWins}/${total}`;
  else if (drawRate != null && drawRate >= 0.35) dominantMarketLabel = `H2H: ${draws}/${total} empates`;

  return {
    total,
    homeWins,
    awayWins,
    draws,
    over25,
    btts,
    homeRate: homeRate != null ? round(homeRate, 3) : null,
    awayRate: awayRate != null ? round(awayRate, 3) : null,
    overRate: overRate != null ? round(overRate, 3) : null,
    bttsRate: bttsRate != null ? round(bttsRate, 3) : null,
    avgGoals: avgGoals != null ? round(avgGoals, 2) : null,
    dominantMarketLabel,
  };
}

const LEAGUE_AVG_GOALS = 1.35;
const DIXON_COLES_TAU = 0.13;
const DEFAULT_HOME_ADVANTAGE = 0.54;

function poissonPmf(k, lambda) {
  if (k < 0 || !Number.isFinite(lambda) || lambda <= 0) return 0;
  let logP = -lambda;
  for (let i = 1; i <= k; i++) logP += Math.log(lambda / i);
  return Math.exp(logP);
}

function dixonColesRho(homeGoals, awayGoals, lambdaHome, lambdaAway, tau = DIXON_COLES_TAU) {
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaHome * lambdaAway * tau;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaAway * tau;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaHome * tau;
  if (homeGoals === 1 && awayGoals === 1) return 1 - tau;
  return 1;
}

/**
 * Ventaja local real: (win% casa − win% fuera) / 2 + 0.5, rango ~0.30–0.75.
 */
export function computeHomeVenueAdvantage(homeSamples = [], awaySamples = []) {
  const homeAtHome = homeSamples.filter((item) => item.isHome);
  const homeAway = homeSamples.filter((item) => !item.isHome);
  const awayAway = awaySamples.filter((item) => !item.isHome);
  const awayAtHome = awaySamples.filter((item) => item.isHome);

  const homeHomeWin =
    homeAtHome.length > 0
      ? homeAtHome.filter((item) => item.result === "W").length / homeAtHome.length
      : null;
  const homeAwayWin =
    homeAway.length > 0 ? homeAway.filter((item) => item.result === "W").length / homeAway.length : null;
  const awayAwayWin =
    awayAway.length > 0 ? awayAway.filter((item) => item.result === "W").length / awayAway.length : null;
  const awayHomeWin =
    awayAtHome.length > 0 ? awayAtHome.filter((item) => item.result === "W").length / awayAtHome.length : null;

  const homeWinRate = homeHomeWin ?? homeSamples.filter((item) => item.result === "W").length / Math.max(homeSamples.length, 1);
  const awayWinRate = awayAwayWin ?? awaySamples.filter((item) => item.result === "W").length / Math.max(awaySamples.length, 1);

  const homeSideRate = Number.isFinite(homeHomeWin) && Number.isFinite(homeAwayWin) ? (homeHomeWin + (1 - homeAwayWin)) / 2 : homeWinRate;
  const awaySideRate = Number.isFinite(awayAwayWin) && Number.isFinite(awayHomeWin) ? (awayAwayWin + (1 - awayHomeWin)) / 2 : 1 - awayWinRate;

  const homeAdvantage = clamp((homeSideRate - awaySideRate) / 2 + 0.5, 0.3, 0.75);
  const gamma = clamp(1.0 + (homeAdvantage - DEFAULT_HOME_ADVANTAGE) * 2.5, 1.05, 1.65);

  return {
    homeAdvantage: round(homeAdvantage, 3),
    gamma: round(gamma, 3),
    homeWinRate: round(homeWinRate, 3),
    awayWinRate: round(awayWinRate, 3),
  };
}

function buildDixonLambdas(xgHome, xgAway, homeGamma = 1.35) {
  if (!Number.isFinite(xgHome) || !Number.isFinite(xgAway) || xgHome <= 0 || xgAway <= 0) return null;
  const alphaHome = xgHome / LEAGUE_AVG_GOALS;
  const alphaAway = xgAway / LEAGUE_AVG_GOALS;
  const lambdaHome = clamp(xgHome * alphaHome * homeGamma, 0.35, 4.5);
  const lambdaAway = clamp(xgAway * alphaAway, 0.35, 4.5);
  return { lambdaHome, lambdaAway, alphaHome: round(alphaHome, 3), alphaAway: round(alphaAway, 3), gamma: round(homeGamma, 3) };
}

function estimatePoisson1x2(lambdaHome, lambdaAway, maxGoals = 8, tau = DIXON_COLES_TAU) {
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway) || lambdaHome <= 0 || lambdaAway <= 0) return null;
  let p1 = 0;
  let px = 0;
  let p2 = 0;

  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals += 1) {
      const base = poissonPmf(homeGoals, lambdaHome) * poissonPmf(awayGoals, lambdaAway);
      const probability = base * dixonColesRho(homeGoals, awayGoals, lambdaHome, lambdaAway, tau);
      if (homeGoals > awayGoals) p1 += probability;
      else if (homeGoals === awayGoals) px += probability;
      else p2 += probability;
    }
  }

  const sum = p1 + px + p2;
  if (sum < 0.5) return null;
  return {
    model_home_prob: round(p1 / sum, 3),
    model_draw_prob: round(px / sum, 3),
    model_away_prob: round(p2 / sum, 3),
    lambda_home: round(lambdaHome, 3),
    lambda_away: round(lambdaAway, 3),
  };
}

function buildMatchModel(homeRecent, awayRecent, venueAdvantage = null) {
  const expectedHomeGoals = averageOf(
    [
      homeRecent?.goalsForAvg,
      awayRecent?.goalsAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedAwayGoals = averageOf(
    [
      awayRecent?.goalsForAvg,
      homeRecent?.goalsAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedHomeCorners = averageOf(
    [
      homeRecent?.cornersForAvg,
      awayRecent?.cornersAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedAwayCorners = averageOf(
    [
      awayRecent?.cornersForAvg,
      homeRecent?.cornersAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedCorners =
    expectedHomeCorners != null && expectedAwayCorners != null
      ? expectedHomeCorners + expectedAwayCorners
      : averageOf(
        [
          homeRecent?.cornersForAvg,
          awayRecent?.cornersForAvg,
          homeRecent?.cornersAgainstAvg,
          awayRecent?.cornersAgainstAvg,
        ].map((value) => ({ value })),
        "value"
      );
  const expectedHomeCards = averageOf(
    [
      homeRecent?.cardsForAvg,
      awayRecent?.cardsAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedAwayCards = averageOf(
    [
      awayRecent?.cardsForAvg,
      homeRecent?.cardsAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedCards =
    expectedHomeCards != null && expectedAwayCards != null
      ? expectedHomeCards + expectedAwayCards
      : averageOf(
        [
          homeRecent?.cardsForAvg,
          awayRecent?.cardsForAvg,
          homeRecent?.cardsAgainstAvg,
          awayRecent?.cardsAgainstAvg,
        ].map((value) => ({ value })),
        "value"
      );
  const expectedHomeShots = averageOf(
    [
      homeRecent?.shotsForAvg,
      awayRecent?.shotsAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedAwayShots = averageOf(
    [
      awayRecent?.shotsForAvg,
      homeRecent?.shotsAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedHomeShotsOnTarget = averageOf(
    [
      homeRecent?.shotsOnTargetAvg,
      awayRecent?.shotsOnTargetAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );
  const expectedAwayShotsOnTarget = averageOf(
    [
      awayRecent?.shotsOnTargetAvg,
      homeRecent?.shotsOnTargetAgainstAvg,
    ].map((value) => ({ value })),
    "value"
  );

  return {
    expectedHomeGoals: expectedHomeGoals != null ? round(expectedHomeGoals, 2) : null,
    expectedAwayGoals: expectedAwayGoals != null ? round(expectedAwayGoals, 2) : null,
    expectedGoals:
      expectedHomeGoals != null && expectedAwayGoals != null ? round(expectedHomeGoals + expectedAwayGoals, 2) : null,
    expectedCorners: expectedCorners != null ? round(expectedCorners, 2) : null,
    expectedCards: expectedCards != null ? round(expectedCards, 2) : null,
    expectedHomeCorners: expectedHomeCorners != null ? round(expectedHomeCorners, 2) : null,
    expectedAwayCorners: expectedAwayCorners != null ? round(expectedAwayCorners, 2) : null,
    expectedHomeCards: expectedHomeCards != null ? round(expectedHomeCards, 2) : null,
    expectedAwayCards: expectedAwayCards != null ? round(expectedAwayCards, 2) : null,
    expectedHomeShots: expectedHomeShots != null ? round(expectedHomeShots, 2) : null,
    expectedAwayShots: expectedAwayShots != null ? round(expectedAwayShots, 2) : null,
    expectedHomeShotsOnTarget: expectedHomeShotsOnTarget != null ? round(expectedHomeShotsOnTarget, 2) : null,
    expectedAwayShotsOnTarget: expectedAwayShotsOnTarget != null ? round(expectedAwayShotsOnTarget, 2) : null,
    venueAdvantage: venueAdvantage?.homeAdvantage ?? null,
    home_gamma: venueAdvantage?.gamma ?? 1.35,
    ...(() => {
      const lambdas = buildDixonLambdas(expectedHomeGoals, expectedAwayGoals, venueAdvantage?.gamma ?? 1.35);
      return lambdas ? estimatePoisson1x2(lambdas.lambdaHome, lambdas.lambdaAway) || {} : {};
    })(),
  };
}

function buildTeamSeason(summary, teamId, standingMeta) {
  const team = extractTeamStatsFromSummary(summary, teamId);
  const stats = team?.statistics || [];
  const goals = extractStatValue(stats, "totalGoals");
  const goalsAgainst = extractStatValue(stats, "goalsConceded");
  const goalDiff = extractStatValue(stats, "goalDifference");
  const matchesPlayed = standingMeta?.gamesPlayed ?? null;
  return {
    goalsPerGame: goals != null && matchesPlayed ? round(goals / matchesPlayed, 2) : null,
    goalsAgainstPerGame: goalsAgainst != null && matchesPlayed ? round(goalsAgainst / matchesPlayed, 2) : null,
    goalDiffPerGame: goalDiff != null && matchesPlayed ? round(goalDiff / matchesPlayed, 2) : null,
    totalGoals: goals != null ? goals : null,
    goalsAgainst: goalsAgainst != null ? goalsAgainst : null,
    goalDifference: goalDiff != null ? goalDiff : null,
  };
}

function enrichStandingMeta(standingEntry) {
  const stats = Array.isArray(standingEntry?.stats) ? standingEntry.stats : [];
  return {
    rank: stats.find((item) => item?.name === "rank")?.value ?? null,
    gamesPlayed: stats.find((item) => item?.name === "gamesPlayed")?.value ?? null,
    points: stats.find((item) => item?.name === "points")?.value ?? null,
    recordLabel: stats.find((item) => item?.name === "overall" || item?.id === "0")?.summary || null,
  };
}

function buildTeamContext(summary, teamId, fallbackName, standingEntry, recentStats) {
  const teamBlock = extractTeamStatsFromSummary(summary, teamId);
  const teamName = teamBlock?.team?.displayName || fallbackName;
  const teamStats = teamBlock?.statistics || [];
  const standingMeta = enrichStandingMeta(standingEntry || {});
  return {
    id: teamId ? String(teamId) : null,
    name: teamName,
    record: {
      label: standingMeta.recordLabel || null,
      pointsPerGame:
        standingMeta.points != null && standingMeta.gamesPlayed ? round(Number(standingMeta.points) / Number(standingMeta.gamesPlayed), 2) : null,
    },
    form: {
      sequence: recentStats.sequence || "",
    },
    recent: recentStats,
    season: buildTeamSeason(summary, teamId, standingMeta),
    leaders: {
      goals: null,
      shots: null,
    },
    standings: {
      rank: standingMeta.rank != null ? Number(standingMeta.rank) : null,
      totalTeams: standingEntry?.totalTeams || null,
      points: standingMeta.points != null ? Number(standingMeta.points) : null,
    },
    summaryStats: {
      shots: extractStatValue(teamStats, "totalShots"),
      shotsOnTarget: extractStatValue(teamStats, "shotsOnTarget"),
      corners: extractStatValue(teamStats, "wonCorners"),
      cards:
        extractStatValue(teamStats, "yellowCards") != null || extractStatValue(teamStats, "redCards") != null
          ? (extractStatValue(teamStats, "yellowCards") || 0) + (extractStatValue(teamStats, "redCards") || 0) * 2
          : null,
    },
  };
}

function buildCurrentInsight(evento, summary, recentSummaries) {
  const competitors = extractCompetitors(summary?.header?.competitions?.[0] ? summary.header : null) || [];
  const currentCompetition = summary?.header?.competitions?.[0] || null;
  const currentCompetitors = Array.isArray(currentCompetition?.competitors) ? currentCompetition.competitors : [];
  const homeCompetitor = currentCompetitors.find((entry) => entry?.homeAway === "home") || currentCompetitors[0];
  const awayCompetitor = currentCompetitors.find((entry) => entry?.homeAway === "away") || currentCompetitors[1];
  const homeTeamId = homeCompetitor?.team?.id || homeCompetitor?.id || null;
  const awayTeamId = awayCompetitor?.team?.id || awayCompetitor?.id || null;

  const standingsEntries = Array.isArray(summary?.standings?.[0]?.groups?.[0]?.standings?.entries)
    ? summary.standings[0].groups[0].standings.entries
    : Array.isArray(summary?.standings?.[0]?.entries)
      ? summary.standings[0].entries
      : [];
  const standingsMap = new Map(
    standingsEntries.map((entry) => [
      String(entry?.id || entry?.team?.id || ""),
      { ...entry, totalTeams: standingsEntries.length || null },
    ])
  );

  const formEntries = Array.isArray(summary?.boxscore?.form) ? summary.boxscore.form : [];
  const homeForm = formEntries.find((entry) => String(entry?.team?.id || "") === String(homeTeamId || "")) || null;
  const awayForm = formEntries.find((entry) => String(entry?.team?.id || "") === String(awayTeamId || "")) || null;

  const homeRecent = buildRecentTeamStats(homeForm, recentSummaries, homeTeamId);
  const awayRecent = buildRecentTeamStats(awayForm, recentSummaries, awayTeamId);
  const homeFormEvents = Array.isArray(homeForm?.events) ? homeForm.events.slice(0, 12) : [];
  const awayFormEvents = Array.isArray(awayForm?.events) ? awayForm.events.slice(0, 12) : [];
  const homeSamples = buildRecentMatchSamples(homeFormEvents, recentSummaries, homeTeamId);
  const awaySamples = buildRecentMatchSamples(awayFormEvents, recentSummaries, awayTeamId);
  const venueAdvantage = computeHomeVenueAdvantage(homeSamples, awaySamples);
  const homeContext = buildTeamContext(summary, homeTeamId, evento.home, standingsMap.get(String(homeTeamId || "")), homeRecent);
  const awayContext = buildTeamContext(summary, awayTeamId, evento.away, standingsMap.get(String(awayTeamId || "")), awayRecent);
  const matchModel = buildMatchModel(homeRecent, awayRecent, venueAdvantage);
  const h2h = buildH2HStats(summary, homeTeamId, awayTeamId, homeContext.name, awayContext.name);
  const officials = Array.isArray(summary?.gameInfo?.officials) ? summary.gameInfo.officials : [];

  return {
    eventId: String(evento.id),
    leagueSlug: resolveLeagueSlugFromEvent(evento),
    stadium: summary?.gameInfo?.venue?.fullName || currentCompetition?.venue?.fullName || null,
    referee: officials[0]?.displayName || officials[0]?.name || null,
    homeTeam: homeContext,
    awayTeam: awayContext,
    matchModel,
    h2h,
    ctx: {
      forma: homeRecent.sequence.split("").filter(Boolean),
      home_forma: homeRecent.sequence.split("").filter(Boolean),
      away_forma: awayRecent.sequence.split("").filter(Boolean),
      goles_favor_local: homeRecent.goalsForAvg ?? 0,
      goles_favor_away: awayRecent.goalsForAvg ?? 0,
      home_goals_for: homeRecent.goalsForAvg ?? 0,
      away_goals_for: awayRecent.goalsForAvg ?? 0,
      home_win_rate: homeRecent.winRate ?? 0.42,
      away_win_rate: awayRecent.winRate ?? 0.28,
      posicion: homeContext.standings.rank ?? 10,
      home_posicion: homeContext.standings.rank ?? 10,
      away_posicion: awayContext.standings.rank ?? 10,
      total_equipos: homeContext.standings.totalTeams || awayContext.standings.totalTeams || 20,
      lesiones: [],
      home_lesiones: [],
      away_lesiones: [],
      esTopLeague: Boolean(resolveLeagueSlugFromEvent(evento)),
      expected_goals: matchModel.expectedGoals ?? null,
      expected_corners_total: matchModel.expectedCorners ?? null,
      expected_cards_total: matchModel.expectedCards ?? null,
      home_shots_for: homeRecent.shotsForAvg ?? null,
      away_shots_for: awayRecent.shotsForAvg ?? null,
      home_shots_on_target: homeRecent.shotsOnTargetAvg ?? null,
      away_shots_on_target: awayRecent.shotsOnTargetAvg ?? null,
      home_corners_for: homeRecent.cornersForAvg ?? null,
      away_corners_for: awayRecent.cornersForAvg ?? null,
      home_corners_against: homeRecent.cornersAgainstAvg ?? null,
      away_corners_against: awayRecent.cornersAgainstAvg ?? null,
      home_cards_for: homeRecent.cardsForAvg ?? null,
      away_cards_for: awayRecent.cardsForAvg ?? null,
      home_season_ppg: homeContext.record.pointsPerGame ?? null,
      away_season_ppg: awayContext.record.pointsPerGame ?? null,
      h2h_home_win_rate: h2h.homeRate ?? null,
      h2h_away_win_rate: h2h.awayRate ?? null,
      h2h_market_label: h2h.dominantMarketLabel || null,
      h2h_over25_rate: h2h.overRate ?? null,
      h2h_btts_rate: h2h.bttsRate ?? null,
      h2h_avg_goals: h2h.avgGoals ?? null,
      model_home_prob: matchModel.model_home_prob ?? null,
      model_draw_prob: matchModel.model_draw_prob ?? null,
      model_away_prob: matchModel.model_away_prob ?? null,
      home_venue_advantage: venueAdvantage.homeAdvantage ?? null,
      home_gamma: venueAdvantage.gamma ?? null,
      lambda_home: matchModel.lambda_home ?? null,
      lambda_away: matchModel.lambda_away ?? null,
    },
  };
}

async function loadRecentSummaries(summary) {
  const fetchList = buildRecentEventFetchList(summary, 8);
  const unique = new Map();
  for (const item of fetchList) {
    if (!item?.eventId || !item?.leagueSlug) continue;
    if (!unique.has(item.eventId)) unique.set(item.eventId, item.leagueSlug);
  }

  const summaryEntries = await Promise.all(
    [...unique.entries()].map(async ([eventId, leagueSlug]) => {
      const payload = await fetchSummary(leagueSlug, eventId);
      return [eventId, payload];
    })
  );

  return new Map(summaryEntries.filter((entry) => entry[1]));
}

function eventKickoffMs(event) {
  const raw = event?.date || event?.competitions?.[0]?.date || event?.competitions?.[0]?.startDate;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function pickBestScoreboardEvent(events, evento) {
  const targetMs = Date.parse(evento?.date);
  const candidates = (events || [])
    .map((entry) => ({
      entry,
      score: scoreboardMatchScore(entry, evento.home, evento.away),
      kickoffMs: eventKickoffMs(entry),
    }))
    .filter((item) => item.score >= 0.58);

  const exact = candidates.filter((item) => item.score >= 0.999);
  if (exact.length === 1) return exact[0].entry;

  if (Number.isFinite(targetMs)) {
    const timeMatched = candidates.filter(
      (item) => item.kickoffMs != null && Math.abs(item.kickoffMs - targetMs) <= 90 * 60 * 1000
    );
    if (timeMatched.length === 1) return timeMatched[0].entry;
    if (timeMatched.length > 1) {
      timeMatched.sort((left, right) => Math.abs(left.kickoffMs - targetMs) - Math.abs(right.kickoffMs - targetMs));
      return timeMatched[0].entry;
    }
    if (candidates.length && !exact.length) return null;
  }

  candidates.sort((left, right) => right.score - left.score);
  if (candidates.length >= 2 && Math.abs(candidates[0].score - candidates[1].score) < 0.01) return null;
  return candidates[0]?.entry || null;
}

export async function loadEspnSoccerInsights(eventosHoy, date) {
  const grouped = new Map();
  for (const evento of eventosHoy || []) {
    const leagueSlug = resolveLeagueSlugFromEvent(evento);
    if (!leagueSlug) continue;
    const group = grouped.get(leagueSlug) || [];
    group.push(evento);
    grouped.set(leagueSlug, group);
  }

  const scoreboardDates = new Set([String(date || "").slice(0, 10)]);
  for (const evento of eventosHoy || []) {
    const eventDate = String(evento.date || date || "").slice(0, 10);
    if (eventDate) scoreboardDates.add(eventDate);
  }

  const scoreboards = new Map();
  await Promise.all(
    [...grouped.keys()].flatMap((leagueSlug) =>
      [...scoreboardDates].map(async (eventDate) => {
        scoreboards.set(`${leagueSlug}|${eventDate}`, await fetchScoreboard(leagueSlug, eventDate));
      })
    )
  );

  const insights = {};

  for (const evento of eventosHoy || []) {
    const leagueSlug = resolveLeagueSlugFromEvent(evento);
    if (!leagueSlug) continue;
    const eventDate = String(evento.date || date || "").slice(0, 10);
    const scoreboard = scoreboards.get(`${leagueSlug}|${eventDate}`);
    const events = Array.isArray(scoreboard?.events) ? scoreboard.events : [];
    const matchedEvent = pickBestScoreboardEvent(events, evento);
    if (!matchedEvent?.id) continue;

    const summary = await fetchSummary(leagueSlug, matchedEvent.id);
    if (!summary) continue;
    const recentSummaries = await loadRecentSummaries(summary);
    insights[evento.id] = buildCurrentInsight(evento, summary, recentSummaries);
  }

  return insights;
}

/**
 * Enriquece filas de la quiniela que no encontraron match en el análisis de fútbol.
 * Busca en las ligas españolas (La Liga, Segunda, Copa del Rey) por nombre de equipo
 * en una ventana de fecha de hoy + 3 días para cubrir toda la jornada de fin de semana.
 * @param {Array<{order:number, home:string, away:string}>} rows
 * @param {string} dateStr YYYY-MM-DD
 * @returns {Object} mapa order → insight de ESPN
 */
export async function fetchEspnInsightsForSpanishRows(rows, dateStr) {
  if (!rows?.length) return {};

  // Ventana de 3 días: la jornada de quiniela se juega el fin de semana siguiente
  const dates = [dateStr, shiftDateStr(dateStr, 1), shiftDateStr(dateStr, 2)];

  // Obtener todos los scoreboards en paralelo (usa la caché interna si ya están)
  const scoreboardCache = new Map();
  await Promise.all(
    SPAIN_QUINIELA_SLUGS.flatMap((slug) =>
      dates.map(async (d) => {
        const key = `${slug}|${d}`;
        const sb = await fetchScoreboard(slug, d).catch(() => null);
        scoreboardCache.set(key, sb);
      })
    )
  );

  const insights = {};

  for (const row of rows) {
    const fakeEvento = { home: row.home, away: row.away };
    let found = false;

    for (const slug of SPAIN_QUINIELA_SLUGS) {
      if (found) break;
      for (const d of dates) {
        const sb = scoreboardCache.get(`${slug}|${d}`);
        const events = Array.isArray(sb?.events) ? sb.events : [];
        const matchedEvent = pickBestScoreboardEvent(events, fakeEvento);
        if (!matchedEvent?.id) continue;

        const summary = await fetchSummary(slug, matchedEvent.id).catch(() => null);
        if (!summary) continue;

        const recentSummaries = await loadRecentSummaries(summary).catch(() => new Map());
        const syntheticEvento = {
          id: String(row.order),
          home: row.home,
          away: row.away,
          league: { slug, name: slug },
        };
        insights[row.order] = buildCurrentInsight(syntheticEvento, summary, recentSummaries);
        found = true;
        break;
      }
    }
  }

  return insights;
}

export { fetchScoreboard as fetchEspnSoccerScoreboard };
