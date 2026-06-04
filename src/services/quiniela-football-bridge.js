const STOP_WORDS = new Set(["fc", "cf", "sd", "ud", "rc", "cd", "sc", "ac", "real", "atletico", "athletic", "sporting", "deportivo", "de", "la", "el", "los", "las"]);

export function normalizeQuinielaTeamName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\br\.\s*/g, "real ")
    .replace(/\bat\.\s*/g, "atletico ")
    .replace(/\s+de\s+/g, " ")
    .toLowerCase()
    .trim();
}

function tokenScore(nameA, nameB) {
  const tokensA = nameA.split(/\s+/).filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  const tokensB = nameB.split(/\s+/).filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  if (!tokensA.length || !tokensB.length) return 0;
  const common = tokensA.filter((t) => tokensB.includes(t)).length;
  return common / Math.max(tokensA.length, tokensB.length);
}

function normalizeTeamName(name) {
  return normalizeQuinielaTeamName(name);
}

export function buildQuinielaPairKey(home, away) {
  const h = normalizeQuinielaTeamName(home);
  const a = normalizeQuinielaTeamName(away);
  if (!h || !a) return "";
  return `${h}|${a}`;
}

export function indexOfficialQuinielaRows(rows = []) {
  const byPair = new Map();
  for (const row of rows) {
    const key = buildQuinielaPairKey(row?.home, row?.away);
    if (key) byPair.set(key, row);
  }
  return byPair;
}

export function isQuinielaOfficialMatch(home, away, rowsOrIndex = []) {
  const homeKey = normalizeQuinielaTeamName(home);
  const awayKey = normalizeQuinielaTeamName(away);
  if (!homeKey || !awayKey) return false;

  const index = rowsOrIndex instanceof Map ? rowsOrIndex : indexOfficialQuinielaRows(rowsOrIndex);
  if (index.has(`${homeKey}|${awayKey}`)) return true;

  for (const key of index.keys()) {
    const [h, a] = key.split("|");
    if ((h.includes(homeKey) || homeKey.includes(h)) && (a.includes(awayKey) || awayKey.includes(a))) {
      return true;
    }
  }
  return false;
}

export function filterPartidosExcludingQuiniela(partidos = [], rows = []) {
  if (!rows?.length) return partidos;
  return partidos.filter((partido) => !isQuinielaOfficialMatch(partido?.home, partido?.away, rows));
}

export function filterPicksExcludingQuiniela(picks = [], rows = []) {
  if (!rows?.length) return picks;
  return picks.filter((pick) => {
    const label = String(pick?.partido || "");
    const match = label.match(/^(.+?)\s+vs\s+(.+)$/i);
    if (!match) return true;
    return !isQuinielaOfficialMatch(match[1].trim(), match[2].trim(), rows);
  });
}

export function indexFootballPartidos(partidos = []) {
  const byPair = new Map();
  for (const partido of partidos) {
    const home = normalizeTeamName(partido?.home || partido?.homeTeam?.name || "");
    const away = normalizeTeamName(partido?.away || partido?.awayTeam?.name || "");
    if (!home || !away) continue;
    byPair.set(`${home}|${away}`, partido);
  }
  return byPair;
}

export function resolveOfficialPartidoAgainstFootball(cardRow, byPair) {
  const home = normalizeTeamName(cardRow.home);
  const away = normalizeTeamName(cardRow.away);
  const direct = byPair.get(`${home}|${away}`);
  if (direct) return { ...direct, bridgeMatchScore: 1.0 };

  let bestScore = 0;
  let bestPartido = null;
  let bestSubstringOnly = false;

  for (const [key, partido] of byPair.entries()) {
    const [h, a] = key.split("|");
    const hScore = tokenScore(home, h);
    const aScore = tokenScore(away, a);
    const combined = (hScore + aScore) / 2;
    const substringMatch = (h.includes(home) || home.includes(h)) && (a.includes(away) || away.includes(a));
    if (combined >= 0.5 && combined > bestScore) {
      bestScore = combined;
      bestPartido = partido;
      bestSubstringOnly = false;
    } else if (substringMatch && bestScore < 0.5) {
      bestScore = Math.max(bestScore, 0.3);
      bestPartido = partido;
      bestSubstringOnly = true;
    }
  }

  if (bestPartido) {
    return {
      ...bestPartido,
      bridgeMatchScore: Math.round(bestScore * 100) / 100,
      bridgeLowConfidence: bestSubstringOnly || bestScore < 0.5,
    };
  }
  return null;
}

export function buildBundleFromFootballPartido(partido, cardRow = {}) {
  if (!partido) return null;
  return {
    order: cardRow.order ?? null,
    partidoLabel: `${cardRow.home || partido.home} vs ${cardRow.away || partido.away}`,
    eventId: partido.eventId || partido.id || null,
    home: cardRow.home || partido.home,
    away: cardRow.away || partido.away,
    matchModel: partido.matchModel || null,
    footballCtx: partido.footballCtx || null,
    mlOdds: partido.mlOdds || null,
    oddsDrop: partido.oddsDrop || null,
    lineMovementInput: partido.lineMovementInput || null,
    lineMovementMl: partido.lineMovementMl || null,
    lineups: partido.lineups || null,
    homeTeam: partido.homeTeam || null,
    awayTeam: partido.awayTeam || null,
    dataSource: partido.source || partido.footballCtx?.source || "football-desk",
    isPlaceholder: false,
    bridgeSource: "football-partido",
  };
}

export function buildBundleFromEspnInsight(insight, cardRow = {}) {
  if (!insight) return null;
  const ctx = insight.ctx || {};
  return {
    order: cardRow.order ?? null,
    partidoLabel: `${cardRow.home} vs ${cardRow.away}`,
    eventId: insight.eventId || `quiniela-espn-${cardRow.order}`,
    home: cardRow.home,
    away: cardRow.away,
    matchModel: insight.matchModel || null,
    footballCtx: {
      source: ctx.__source || ctx.source || "espn-direct",
      lambda_home: ctx.lambda_home ?? ctx.model_goals_home ?? null,
      lambda_away: ctx.lambda_away ?? ctx.model_goals_away ?? null,
      model_home_prob: ctx.model_home_prob ?? insight.matchModel?.model_home_prob ?? null,
      model_draw_prob: ctx.model_draw_prob ?? insight.matchModel?.model_draw_prob ?? null,
      model_away_prob: ctx.model_away_prob ?? insight.matchModel?.model_away_prob ?? null,
      expected_goals: ctx.expected_goals ?? insight.matchModel?.expectedGoals ?? null,
      home_goals_for: ctx.home_goals_for ?? ctx.goles_favor_local ?? null,
      away_goals_for: ctx.away_goals_for ?? ctx.goles_favor_away ?? null,
      home_goals_against: ctx.home_goals_against ?? ctx.home_season_goals_against ?? null,
      away_goals_against: ctx.away_goals_against ?? ctx.away_season_goals_against ?? null,
      goles_favor_local: ctx.goles_favor_local ?? ctx.home_goals_for ?? null,
      goles_favor_away: ctx.goles_favor_away ?? ctx.away_goals_for ?? null,
      forma: Array.isArray(ctx.forma) ? ctx.forma : [],
      home_forma: Array.isArray(ctx.home_forma) ? ctx.home_forma : [],
      away_forma: Array.isArray(ctx.away_forma) ? ctx.away_forma : [],
      home_recent_matches: Array.isArray(ctx.home_recent_matches) ? ctx.home_recent_matches : [],
      away_recent_matches: Array.isArray(ctx.away_recent_matches) ? ctx.away_recent_matches : [],
      home_win_rate: ctx.home_win_rate ?? null,
      away_win_rate: ctx.away_win_rate ?? null,
      home_win_rate_home: ctx.home_win_rate_home ?? null,
      away_win_rate_away: ctx.away_win_rate_away ?? null,
      home_attack_strength: ctx.home_attack_strength ?? ctx.model_home_attack_strength ?? null,
      away_attack_strength: ctx.away_attack_strength ?? ctx.model_away_attack_strength ?? null,
      home_defence_strength: ctx.home_defence_strength ?? ctx.model_home_defence_strength ?? null,
      away_defence_strength: ctx.away_defence_strength ?? ctx.model_away_defence_strength ?? null,
      h2h_home_win_rate: ctx.h2h_home_win_rate ?? ctx.model_h2h_home_rate ?? null,
      h2h_draw_rate: ctx.h2h_draw_rate ?? ctx.model_h2h_draw_rate ?? null,
      h2h_away_win_rate: ctx.h2h_away_win_rate ?? ctx.model_h2h_away_rate ?? null,
      home_btts_rate: ctx.home_btts_rate ?? null,
      away_btts_rate: ctx.away_btts_rate ?? null,
      model_btts_rate: ctx.model_btts_rate ?? null,
      home_over25_rate: ctx.home_over25_rate ?? null,
      away_over25_rate: ctx.away_over25_rate ?? null,
      api_sports_under_over: ctx.api_sports_under_over ?? ctx.model_under_over ?? null,
      api_sports_has_predictions: Boolean(ctx.api_sports_has_predictions),
      home_lineup_confirmed: Boolean(ctx.home_lineup_confirmed),
      away_lineup_confirmed: Boolean(ctx.away_lineup_confirmed),
      lineup_confirmed: Boolean(ctx.lineup_confirmed),
      injuries: 0,
    },
    mlOdds: null,
    oddsDrop: null,
    lineups: insight.lineups || null,
    homeTeam: insight.homeTeam || null,
    awayTeam: insight.awayTeam || null,
    dataSource: ctx.__source || ctx.source || "espn-direct",
    isPlaceholder: false,
    bridgeSource: "espn-direct",
  };
}

export function buildUncertainBundle(cardRow) {
  return {
    order: cardRow.order ?? null,
    partidoLabel: `${cardRow.home} vs ${cardRow.away}`,
    eventId: `quiniela-unknown-${cardRow.order}`,
    home: cardRow.home,
    away: cardRow.away,
    matchModel: null,
    footballCtx: null,
    mlOdds: null,
    oddsDrop: null,
    lineups: null,
    homeTeam: { name: cardRow.home },
    awayTeam: { name: cardRow.away },
    dataSource: "no-data",
    isPlaceholder: true,
    bridgeSource: "uncertain",
  };
}

export function buildFootballMatchBundle(cardRow, byPair, espnInsights = {}) {
  const partido = resolveOfficialPartidoAgainstFootball(cardRow, byPair);
  if (partido) return buildBundleFromFootballPartido(partido, cardRow);
  const insight = espnInsights[cardRow.order];
  if (insight) return buildBundleFromEspnInsight(insight, cardRow);
  return buildUncertainBundle(cardRow);
}

export function bundleToMatchShape(bundle) {
  if (!bundle) return null;
  return {
    id: bundle.eventId,
    homeTeam: bundle.homeTeam || { name: bundle.home },
    awayTeam: bundle.awayTeam || { name: bundle.away },
    matchModel: bundle.matchModel || {},
    footballCtx: bundle.footballCtx,
    mlOdds: bundle.mlOdds,
    oddsDrop: bundle.oddsDrop,
    lineMovementInput: bundle.lineMovementInput || null,
    lineMovementMl: bundle.lineMovementMl || null,
    lineups: bundle.lineups,
    stadium: bundle.stadium || null,
    referee: bundle.referee || null,
    scheduledAt: bundle.scheduledAt || null,
    date: bundle.date || null,
    status: "scheduled",
    dataSource: bundle.dataSource,
  };
}
