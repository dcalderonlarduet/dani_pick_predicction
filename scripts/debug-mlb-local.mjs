import { buildMlbAnalysis } from "../src/services/mlb-analyzer.js";
import { getMadridTodayDateString } from "../src/utils/madrid-date.js";

const date = getMadridTodayDateString();
try {
  const data = await buildMlbAnalysis(date);
  console.log(JSON.stringify({
    dataAvailable: data.dataAvailable,
    games: data.games?.length ?? 0,
    unavailableReason: data.unavailableReason,
    slateSummary: data.slateSummary,
  }, null, 2));
} catch (error) {
  console.error("ERROR:", error?.stack || error?.message || error);
}
