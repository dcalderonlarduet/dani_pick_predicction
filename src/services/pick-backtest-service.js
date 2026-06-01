import { savePick, updateResult, getStats, getCLVReport, persistPolicyPicks, mapProPickToBacktestRecord } from "./backtesting.js";

/** @deprecated Usar backtesting.js directamente */
export async function recordAnalysisSnapshots(sport, analysis, date) {
  const games = Array.isArray(analysis?.games) ? analysis.games : [];
  let recorded = 0;
  for (const game of games) {
    const picks = game.recommendations || game.picks || [];
    const rows = await persistPolicyPicks(game, picks, sport, analysis?.league);
    recorded += rows.length;
  }
  return { recorded, skipped: false, date };
}

export { getStats as getBacktestStats };
export { savePick, updateResult, getStats, getCLVReport, persistPolicyPicks, mapProPickToBacktestRecord };
