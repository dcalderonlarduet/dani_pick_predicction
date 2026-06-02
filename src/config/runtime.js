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

function preferredOddsProvider() {
  if (process.env.ODDS_API_IO_KEY) return "odds-api-io";
  if (process.env.THE_ODDS_API_KEY) return "the-odds-api";
  return "none";
}

export function getRuntimeConfig() {
  const oddsProvider = preferredOddsProvider();

  return {
    timezone: process.env.APP_TIMEZONE || "Europe/Madrid",
    oddsProvider,
    communityStack: {
      enabled: false,
    },
    oddsApiIo: {
      enabled: oddsProvider === "odds-api-io" || Boolean(process.env.ODDS_API_IO_KEY),
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
      timezone: process.env.APISPORTS_FOOTBALL_TIMEZONE || process.env.APP_TIMEZONE || "Europe/Madrid",
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
    sharpBook: process.env.SHARP_BOOK || "Bet365",
    retailBook: process.env.RETAIL_BOOK || "Winamax FR",
  };
}

export function describeRuntime(config = getRuntimeConfig()) {
  return {
    oddsProvider: config.oddsProvider,
    timezone: config.timezone,
  };
}
