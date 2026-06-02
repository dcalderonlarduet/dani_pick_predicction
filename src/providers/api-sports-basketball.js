import { getRuntimeConfig } from "../config/runtime.js";
import {
  apiSportsSeasonLabel,
  apiSportsSeasonYear,
  fetchApiSportsGameStatistics,
  fetchApiSportsGames,
  fetchApiSportsTeamStatistics,
  matchApiSportsGame,
  parseApiSportsH2hFullTotal,
  parseApiSportsH2hTotals,
  parseBasketballTeamStats,
} from "./shared/api-sports-pro.js";

const NBA_LEAGUE_ID = 12;

export function getApiSportsBasketballConfig() {
  const cfg = getRuntimeConfig().apiSportsBasketball || {};
  return {
    enabled: Boolean(cfg.enabled && cfg.apiKey),
    apiKey: cfg.apiKey || "",
    baseUrl: cfg.baseUrl || "https://v1.basketball.api-sports.io",
    league: cfg.leagueId || NBA_LEAGUE_ID,
    namespace: "api-sports-basketball",
  };
}

export async function loadApiSportsBasketballGameInsight({ date, home, away }) {
  const config = getApiSportsBasketballConfig();
  if (!config.enabled) return null;

  const season = apiSportsSeasonLabel(date);
  const games = await fetchApiSportsGames(config, {
    date,
    league: config.league,
    season,
  });
  const match = matchApiSportsGame(games, home, away);
  if (!match) return null;

  const statsRows = await fetchApiSportsGameStatistics(config, match?.game?.id || match?.id);
  const homeId = match?.teams?.home?.id;
  const awayId = match?.teams?.away?.id;

  const [homeStats, awayStats] = await Promise.all([
    homeId
      ? fetchApiSportsTeamStatistics(config, {
          teamId: homeId,
          league: config.league,
          season,
        })
      : null,
    awayId
      ? fetchApiSportsTeamStatistics(config, {
          teamId: awayId,
          league: config.league,
          season,
        })
      : null,
  ]);

  const h2hGames = await fetchApiSportsGames(config, {
    h2h: `${homeId}-${awayId}`,
    league: config.league,
    season,
  }).catch(() => []);

  return {
    source_log: { api_sports_game: true },
    gameId: match?.game?.id || match?.id,
    home: {
      teamId: homeId,
      form: parseBasketballTeamStats(homeStats) || inferFromGameStats(statsRows, "home"),
    },
    away: {
      teamId: awayId,
      form: parseBasketballTeamStats(awayStats) || inferFromGameStats(statsRows, "away"),
    },
    h2h: {
      averageTotal: parseApiSportsH2hFullTotal(h2hGames),
    },
    h2h_1h: parseApiSportsH2hTotals(h2hGames, "nba"),
    injuries: parseApiSportsInjuries(statsRows),
    flags: {
      stats_espn_disponibles: Boolean(homeStats || awayStats),
      lesiones_confirmadas: false,
      alineacion_confirmada: false,
      h2h_relevante: Array.isArray(h2hGames) && h2hGames.length >= 3,
      clima_disponible: false,
    },
  };
}

function inferFromGameStats() {
  return null;
}

function parseApiSportsInjuries() {
  return [];
}

export { apiSportsSeasonYear };
