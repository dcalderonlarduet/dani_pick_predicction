const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";

const endpoints = [
  { name: "health", url: "/api/health" },
  { name: "public-splits", url: "/api/public-splits/status" },
  { name: "mlb", url: "/api/mlb/analyze" },
  { name: "futbol", url: "/api/futbol/analyze" },
  { name: "nba", url: "/api/nba/analyze" },
  { name: "wnba", url: "/api/wnba/analyze" },
  { name: "nfl", url: "/api/nfl/analyze" },
  { name: "quiniela", url: "/api/quiniela/analyze" },
];

const results = [];

for (const entry of endpoints) {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}${entry.url}`);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 200) };
    }
    const events =
      entry.name === "public-splits"
        ? payload?.games
        : payload?.games?.length ??
          payload?.partidos?.length ??
          payload?.propuestaOficial?.length ??
          payload?.events ??
          null;
    results.push({
      name: entry.name,
      status: response.status,
      ms: Date.now() - started,
      events: typeof events === "number" ? events : Array.isArray(events) ? events.length : events,
      cache: payload?.cacheMeta?.servedFrom || payload?.cache?.servedFrom || null,
      splitsState: entry.name === "public-splits" ? payload?.state : null,
      message: payload?.message || payload?.error || null,
    });
  } catch (error) {
    results.push({
      name: entry.name,
      status: 0,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({ base: BASE, results }, null, 2));

const failed = results.filter((row) => row.status !== 200);
process.exit(failed.length ? 1 : 0);
