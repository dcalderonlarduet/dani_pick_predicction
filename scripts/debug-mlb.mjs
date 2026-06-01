const res = await fetch("http://localhost:3000/api/mlb/analyze");
const data = await res.json();
console.log(JSON.stringify({
  status: res.status,
  dataAvailable: data.dataAvailable,
  games: data.games?.length ?? null,
  unavailableReason: data.unavailableReason,
  slateSummary: data.slateSummary,
  date: data.date,
}, null, 2));

if (data.games?.length) {
  const g = data.games[0];
  console.log("sample game:", {
    id: g.id,
    startTime: g.startTime,
    scheduleDate: g.scheduleDate,
    status: g.status,
    home: g.homeTeam?.name,
    away: g.awayTeam?.name,
  });
}
