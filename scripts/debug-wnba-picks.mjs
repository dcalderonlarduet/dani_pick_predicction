#!/usr/bin/env node
import { buildWnbaAnalysis } from "../src/services/wnba-analyzer.js";

const analysis = await buildWnbaAnalysis("2026-05-30");

console.log("=== RESUMEN WNBA 2026-05-30 ===");
console.log(`Juegos hoy: ${analysis.games?.length}`);
console.log(`Picks bettable (API picks): ${analysis.picks?.length}`);
console.log(`Model picks: ${analysis.modelPicks?.length}`);
console.log(`Slate: ${JSON.stringify(analysis.slateSummary)}`);

for (const game of analysis.games || []) {
  const hasOdds = Boolean(game.odds?.bookmakers && Object.keys(game.odds.bookmakers).length);
  console.log(`\n--- ${game.away} @ ${game.home} (${game.startTime}) ---`);
  console.log(`  odds: ${hasOdds ? "SI" : "NO"} | recommendations: ${game.recommendations?.length || 0} | picks bettable: ${game.picks?.length || 0}`);
  for (const rec of game.recommendations || []) {
    console.log(
      `  [${rec.color}] ${rec.market} ${rec.side} | score=${rec.score} ev=${rec.ev_model?.toFixed?.(3)} conf=${rec.confidence} bettable=${rec.bettable} dq=${rec.data_quality?.toFixed?.(2)} odds=${rec.odds}`
    );
    if (rec.value_gates && !rec.bettable) {
      console.log(`    gates FAIL: ${(rec.value_gates.failures || []).join(", ")}`);
    }
  }
}

console.log("\n=== PICKS API (UI principal) ===");
for (const p of analysis.picks || []) {
  console.log(`  ${p.label || p.pick_label} | ${p.color} score=${p.score}`);
}

console.log("\n=== MODEL PICKS ===");
for (const p of analysis.modelPicks || []) {
  console.log(`  ${p.label || p.pick_label || p.selection} | ${p.color} score=${p.score} bettable=${p.bettable}`);
}
