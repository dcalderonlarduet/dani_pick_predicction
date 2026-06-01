import path from "node:path";
import "./load-env.js";

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function preferredDataProvider() {
  if (process.env.TENNIS_DATA_PROVIDER) {
    return process.env.TENNIS_DATA_PROVIDER;
  }

  if (process.env.MATCHSTAT_RAPIDAPI_KEY) {
    return "matchstat";
  }

  if (process.env.ODDS_API_IO_KEY) {
    return "odds-api-io";
  }

  if (process.env.FLASHSCORE_SNAPSHOT_FILE) {
    return "community-stack";
  }

  if (process.env.SPORTRADAR_API_KEY) {
    return "sportradar";
  }

  if (process.env.API_TENNIS_API_KEY) {
    return "api-tennis";
  }

  return "matchstat";
}

function preferredOddsProvider(dataProvider) {
  if (process.env.TENNIS_ODDS_PROVIDER) {
    return process.env.TENNIS_ODDS_PROVIDER;
  }

  if (process.env.ODDSHARVESTER_SNAPSHOT_FILE) {
    return "oddsharvester";
  }

  if (process.env.ODDS_API_IO_KEY) {
    return "odds-api-io";
  }

  if (process.env.THE_ODDS_API_KEY) {
    return "the-odds-api";
  }

  if (process.env.API_TENNIS_API_KEY) {
    return "api-tennis";
  }

  return "none";
}

export function getRuntimeConfig() {
  const dataProvider = preferredDataProvider();
  const oddsProvider = preferredOddsProvider(dataProvider);

  return {
    timezone: process.env.TENNIS_TIMEZONE || "Europe/Madrid",
    maxMatches: parseInteger(process.env.TENNIS_MAX_MATCHES, 12),
    recentWindowDays: parseInteger(process.env.TENNIS_RECENT_WINDOW_DAYS, 120),
    dataProvider,
    oddsProvider,
    sportradar: {
      enabled: dataProvider === "sportradar",
      apiKey: process.env.SPORTRADAR_API_KEY || "",
      accessLevel: process.env.SPORTRADAR_ACCESS_LEVEL || "trial",
      language: process.env.SPORTRADAR_LANGUAGE || "en",
      baseUrl: process.env.SPORTRADAR_BASE_URL || "https://api.sportradar.com",
    },
    apiTennis: {
      enabled: dataProvider === "api-tennis" || oddsProvider === "api-tennis",
      apiKey: process.env.API_TENNIS_API_KEY || "",
      timezone: process.env.API_TENNIS_TIMEZONE || process.env.TENNIS_TIMEZONE || "Europe/Madrid",
      baseUrl: process.env.API_TENNIS_BASE_URL || "https://api.api-tennis.com/tennis/",
    },
    matchstat: {
      enabled: dataProvider === "matchstat",
      apiKey: process.env.MATCHSTAT_RAPIDAPI_KEY || "",
      host: process.env.MATCHSTAT_RAPIDAPI_HOST || "tennis-api-atp-wta-itf.p.rapidapi.com",
      baseUrl: process.env.MATCHSTAT_BASE_URL || "https://tennis-api-atp-wta-itf.p.rapidapi.com",
      tours: parseList(process.env.MATCHSTAT_TOURS, ["atp", "wta"]),
      fixtureIncludes: parseList(process.env.MATCHSTAT_FIXTURE_INCLUDES, ["round", "tournament", "tournament.court", "tournament.rank", "h2h"]),
      playerGroup: process.env.MATCHSTAT_PLAYER_GROUP || "singles",
      pageSize: parseInteger(process.env.MATCHSTAT_PAGE_SIZE, 20),
      rankingsPageSize: parseInteger(process.env.MATCHSTAT_RANKINGS_PAGE_SIZE, 200),
      recentMatchesPageSize: parseInteger(process.env.MATCHSTAT_RECENT_MATCHES_PAGE_SIZE, 12),
      h2hPageSize: parseInteger(process.env.MATCHSTAT_H2H_PAGE_SIZE, 20),
    },
    communityStack: {
      enabled: dataProvider === "community-stack" || oddsProvider === "oddsharvester",
      flashscoreSnapshotFile:
        process.env.FLASHSCORE_SNAPSHOT_FILE ||
        path.join(process.cwd(), "src", "data", "community", "flashscore-live.snapshot.json"),
      oddsharvesterSnapshotFile:
        process.env.ODDSHARVESTER_SNAPSHOT_FILE ||
        path.join(process.cwd(), "src", "data", "community", "oddsharvester.snapshot.json"),
    },
    oddsApiIo: {
      enabled: oddsProvider === "odds-api-io" || dataProvider === "odds-api-io",
      apiKey: process.env.ODDS_API_IO_KEY || "",
      baseUrl: process.env.ODDS_API_IO_BASE_URL || "https://api.odds-api.io/v3",
      bookmakers: parseList(process.env.ODDS_API_IO_BOOKMAKERS, ["Bet365", "Winamax FR"]),
    },
    theOddsApi: {
      enabled: oddsProvider === "the-odds-api",
      apiKey: process.env.THE_ODDS_API_KEY || "",
      baseUrl: process.env.THE_ODDS_BASE_URL || "https://api.the-odds-api.com/v4",
      regions: parseList(process.env.THE_ODDS_REGIONS, ["uk", "eu"]),
      markets: parseList(process.env.THE_ODDS_MARKETS, ["h2h", "spreads", "totals"]),
    },
    espn: {
      enabled: parseBoolean(process.env.ESPN_SCOREBOARD_ENABLED, true),
      baseUrl: process.env.ESPN_BASE_URL || "https://site.api.espn.com/apis/site/v2/sports/tennis",
      leagues: parseList(process.env.ESPN_TENNIS_LEAGUES, ["atp", "wta"]),
    },
    sportDevs: {
      enabled: parseBoolean(process.env.SPORTDEVS_ENABLED, false),
      apiKey: process.env.SPORTDEVS_API_KEY || "",
      rapidApiKey: process.env.SPORTDEVS_RAPIDAPI_KEY || "",
      rapidApiHost: process.env.SPORTDEVS_RAPIDAPI_HOST || "",
      baseUrl: process.env.SPORTDEVS_BASE_URL || "https://tennis.sportdevs.com",
      language: process.env.SPORTDEVS_LANG || "en",
      rankingsLimit: parseInteger(process.env.SPORTDEVS_RANKINGS_LIMIT, 200),
      matchesLimit: parseInteger(process.env.SPORTDEVS_MATCHES_LIMIT, 100),
    },
    medical: {
      signalsFile:
        process.env.MEDICAL_SIGNALS_FILE ||
        path.join(process.cwd(), "src", "data", "medical-signals.json"),
      tournamentSurfaceFile:
        process.env.TOURNAMENT_SURFACES_FILE ||
        path.join(process.cwd(), "src", "data", "tournament-surfaces.json"),
    },
    football: {
      oddsProvider: process.env.FOOTBALL_ODDS_PROVIDER || "odds-api-io",
      maxMatches: parseInteger(process.env.FOOTBALL_MAX_MATCHES, 12),
      bookmakers: parseList(process.env.FOOTBALL_BOOKMAKERS || process.env.ODDS_API_IO_BOOKMAKERS, ["Bet365", "Winamax FR"]),
      evThreshold: Number.parseFloat(process.env.FOOTBALL_EV_THRESHOLD || "0.05"),
      minOdds: Number.parseFloat(process.env.FOOTBALL_MIN_ODDS || "1.40"),
      maxOdds: Number.parseFloat(process.env.FOOTBALL_MAX_ODDS || "3.40"),
      minConfidence: parseInteger(process.env.FOOTBALL_MIN_CONFIDENCE, 60),
      dropMin: parseInteger(process.env.FOOTBALL_DROP_MIN, 8),
    },
    apiSportsFootball: {
      enabled: parseBoolean(process.env.APISPORTS_FOOTBALL_ENABLED, Boolean(process.env.APISPORTS_FOOTBALL_KEY)),
      apiKey: process.env.APISPORTS_FOOTBALL_KEY || "",
      baseUrl: process.env.APISPORTS_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io",
      timezone: process.env.APISPORTS_FOOTBALL_TIMEZONE || process.env.TENNIS_TIMEZONE || "Europe/Madrid",
      refreshMinutes: parseInteger(process.env.APISPORTS_FOOTBALL_REFRESH_MINUTES, 25),
      discoveryMinutes: parseInteger(process.env.APISPORTS_FOOTBALL_DISCOVERY_MINUTES, 120),
      detailBudgetPerWindow: parseInteger(process.env.APISPORTS_FOOTBALL_DETAIL_BUDGET, 3),
    },
    apiSportsBasketball: {
      enabled: parseBoolean(process.env.APISPORTS_BASKETBALL_ENABLED, false),
      apiKey: process.env.APISPORTS_BASKETBALL_KEY || process.env.APISPORTS_FOOTBALL_KEY || "",
      baseUrl: process.env.APISPORTS_BASKETBALL_BASE_URL || "https://v1.basketball.api-sports.io",
      leagueId: parseInteger(process.env.APISPORTS_BASKETBALL_LEAGUE_ID, 12),
    },
    apiSportsAmericanFootball: {
      enabled: parseBoolean(
        process.env.APISPORTS_AMERICAN_FOOTBALL_ENABLED,
        Boolean(process.env.APISPORTS_AMERICAN_FOOTBALL_KEY || process.env.APISPORTS_FOOTBALL_KEY)
      ),
      apiKey:
        process.env.APISPORTS_AMERICAN_FOOTBALL_KEY ||
        process.env.APISPORTS_FOOTBALL_KEY ||
        process.env.APISPORTS_BASKETBALL_KEY ||
        "",
      baseUrl:
        process.env.APISPORTS_AMERICAN_FOOTBALL_BASE_URL || "https://v1.american-football.api-sports.io",
      leagueId: parseInteger(process.env.APISPORTS_AMERICAN_FOOTBALL_LEAGUE_ID, 1),
    },
    nba: {
      minOdds: Number.parseFloat(process.env.NBA_MIN_ODDS || "1.72"),
      maxOdds: Number.parseFloat(process.env.NBA_MAX_ODDS || "2.35"),
    },
    nfl: {
      minOdds: Number.parseFloat(process.env.NFL_MIN_ODDS || "1.72"),
      maxOdds: Number.parseFloat(process.env.NFL_MAX_ODDS || "2.35"),
    },
    wnba: {
      minOdds: Number.parseFloat(process.env.WNBA_MIN_ODDS || "1.72"),
      maxOdds: Number.parseFloat(process.env.WNBA_MAX_ODDS || "2.35"),
    },
    tennis: {
      evThreshold: Number.parseFloat(process.env.EV_THRESHOLD || "0.05"),
      minOdds: Number.parseFloat(process.env.MIN_ODDS || "1.40"),
      maxOdds: Number.parseFloat(process.env.MAX_ODDS || "3.00"),
      minConfidence: parseInteger(process.env.MIN_CONFIDENCE, 60),
      dropMin: Number.parseFloat(process.env.TENNIS_DROP_MIN || "5"),
      sharpBook: process.env.SHARP_BOOK || "Bet365",
      retailBook: process.env.RETAIL_BOOK || "Winamax FR",
    },
    mlb: {
      minOdds: Number.parseFloat(process.env.MLB_MIN_ODDS || "1.3"),
      maxOdds: Number.parseFloat(process.env.MLB_MAX_ODDS || "3.5"),
      oddsProvider: process.env.MLB_ODDS_PROVIDER || "",
    },
    publicSplits: {
      enabled: parseBoolean(process.env.PUBLIC_SPLITS_ENABLED, true),
      intervalMs: parseInteger(process.env.PUBLIC_SPLITS_INTERVAL_MS, 20 * 60 * 1000),
      maxAgeMs: parseInteger(process.env.PUBLIC_SPLITS_MAX_AGE_MS, 6 * 60 * 60 * 1000),
      snapshotFile:
        process.env.PUBLIC_SPLITS_SNAPSHOT_FILE ||
        path.join(process.cwd(), "src", "data", "community", "public-splits.snapshot.json"),
      seedFile:
        process.env.PUBLIC_SPLITS_SEED_FILE ||
        path.join(process.cwd(), "src", "data", "community", "public-splits.snapshot.example.json"),
    },
    parlay: {
      evThreshold: Number.parseFloat(process.env.EV_THRESHOLD || "0.05"),
      minOdds: Number.parseFloat(process.env.PARLAY_MIN_ODDS || "1.80"),
      maxOdds: Number.parseFloat(process.env.PARLAY_MAX_ODDS || "4.00"),
    },
  };
}

export function describeRuntime(config = getRuntimeConfig()) {
  return {
    dataProvider: config.dataProvider,
    oddsProvider: config.oddsProvider,
    timezone: config.timezone,
    maxMatches: config.maxMatches,
    recentWindowDays: config.recentWindowDays,
  };
}
