import { getRuntimeConfig } from "../config/runtime.js";
import {
  apiSportsSeasonLabel,
  fetchApiSportsGames,
  fetchApiSportsTeamStatistics,
  matchApiSportsGame,
  parseAmericanFootballTeamStats,
  parseApiSportsH2hTotals,
} from "./shared/api-sports-pro.js";

const NFL_LEAGUE_ID = 1;

export function getApiSportsAmericanFootballConfig() {
  const cfg = getRuntimeConfig().apiSportsAmericanFootball || {};
  return {
    enabled: Boolean(cfg.enabled && cfg.apiKey),
    apiKey: cfg.apiKey || "",
    baseUrl: cfg.baseUrl || "https://v1.american-football.api-sports.io",
    league: cfg.leagueId || NFL_LEAGUE_ID,
    namespace: "api-sports-american-football",
  };
}

export async function loadApiSportsNflGameInsight({ date, home, away }) {
  const config = getApiSportsAmericanFootballConfig();
  if (!config.enabled) return null;

  const season = apiSportsSeasonLabel(date);
  const games = await fetchApiSportsGames(config, {
    date,
    league: config.league,
    season,
  });
  const match = matchApiSportsGame(games, home, away);
  if (!match) return null;

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
      form: parseAmericanFootballTeamStats(homeStats),
    },
    away: {
      teamId: awayId,
      form: parseAmericanFootballTeamStats(awayStats),
    },
    h2h_1h: parseApiSportsH2hTotals(h2hGames, "nfl"),
    flags: {
      stats_espn_disponibles: Boolean(homeStats || awayStats),
      lesiones_confirmadas: false,
      alineacion_confirmada: false,
      h2h_relevante: Array.isArray(h2hGames) && h2hGames.length >= 2,
      clima_disponible: false,
    },
  };
}
