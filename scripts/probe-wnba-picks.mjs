#!/usr/bin/env node
import { buildWnbaAnalysis } from "../src/services/wnba-analyzer.js";

const date = process.argv[2] || new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const analysis = await buildWnbaAnalysis(date);
console.log(`\nWNBA ${date}: ${analysis.games?.length || 0} juegos, ${analysis.picks?.length || 0} picks bettable, ${analysis.modelPicks?.length || 0} model picks\n`);

console.log("\nModel picks (top):");
for (const pick of (analysis.modelPicks || []).slice(0, 10)) {
  console.log(`  [${pick.color}] ${pick.label} score=${pick.score} ev=${pick.ev} bettable=${pick.bettable}`);
}

for (const game of analysis.games || []) {
  const hasOdds = Boolean(game.odds?.bookmakers && Object.keys(game.odds.bookmakers).length);
  const ml = (game.recommendations || []).find((p) => p.market === "moneyline");
  console.log(`${game.away} @ ${game.home} | odds=${hasOdds ? "✓" : "✗"} | ML picks=${(game.recommendations || []).filter((p) => p.market === "moneyline").length}`);
  if (ml) {
    console.log(`  → ${ml.side} color=${ml.color} bettable=${ml.bettable} ev=${ml.ev_model?.toFixed?.(3)} dq=${ml.data_quality?.toFixed?.(2)} odds=${ml.odds}`);
  }
}

console.log("\nTop bettable picks:");
for (const pick of (analysis.picks || []).slice(0, 8)) {
  console.log(`  [${pick.color}] ${pick.label} score=${pick.score} ev=${pick.ev}`);
}
