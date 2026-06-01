const endpoints = [
  "/api/db/health",
  "/",
  "/api/mlb/analyze",
  "/api/wnba/analyze",
  "/api/quiniela/analyze",
];

for (const path of endpoints) {
  const res = await fetch(`http://localhost:3000${path}`);
  let extra = "";
  if (path.includes("/analyze")) {
    const json = await res.json();
    const picks = json.picks || [];
    const sample = picks[0];
    extra = ` picks=${picks.length}`;
    if (sample) {
      extra += ` hora=${sample.hora || sample.hora_partido || "?"}`;
      extra += ` start=${sample.startIso || sample.scheduledAt || "?"}`;
    }
    if (path.includes("quiniela")) {
      extra += ` jornada=${json.officialSource?.jornadaAnalizada || "?"}`;
      extra += ` propuesta=${(json.propuestaOficial || []).length}`;
    }
  } else if (path === "/api/db/health") {
    const json = await res.json();
    extra = ` ok=${json.ok}`;
  } else {
    extra = ` bytes=${(await res.text()).length}`;
  }
  console.log(`${path} -> ${res.status}${extra}`);
}
