import { readFileSync } from "node:fs";
import {
  effectivePitcherRunMetric,
  computeOffenseVsPitcherMatchup,
  recentPitcherFormRunDelta,
} from "../src/services/mlb-model-enhancements.js";
import { computeDataQuality } from "../src/services/pro-odds-scoring.js";
import { applyDataQualityPenalties, MLB_THRESHOLDS } from "../src/services/sport-bettable-thresholds.js";

function tierPitcherRunMetric(value) {
  if (!Number.isFinite(value)) return 4;
  if (value < 3.0) return 10;
  if (value < 3.5) return 8;
  if (value < 4.0) return 6;
  if (value < 4.5) return 4;
  return 2;
}
function tierPitcherVulnerability(value) {
  if (!Number.isFinite(value)) return 4;
  if (value >= 4.5) return 10;
  if (value >= 4.0) return 8;
  if (value >= 3.5) return 6;
  if (value >= 3.0) return 4;
  return 2;
}
function tierWhip(v) { return !Number.isFinite(v) ? 4 : v < 1.05 ? 8 : v < 1.15 ? 6 : v < 1.30 ? 4 : 2; }
function tierWhipVulnerability(v) { return !Number.isFinite(v) ? 4 : v > 1.40 ? 8 : v > 1.30 ? 6 : v > 1.15 ? 4 : 2; }
function tierK9(v) { return !Number.isFinite(v) ? 0 : v > 10 ? 5 : v > 9 ? 4 : v >= 7 ? 2 : 0; }
function tierK9Vulnerability(v) { return !Number.isFinite(v) ? 2 : v < 5 ? 5 : v < 7 ? 4 : v <= 9 ? 2 : 0; }
function tierRest(d) { return d >= 5 ? 3 : d >= 4 ? 2 : d >= 3 ? 1 : 0; }
function tierRestVulnerability(d) { return d < 3 ? 3 : d < 4 ? 2 : d < 5 ? 1 : 0; }
function tierOpsProxy(v) { return !Number.isFinite(v) ? 4 : v > 0.76 ? 10 : v >= 0.72 ? 6 : 2; }
function tierSplitAdvantage(d) { return d > 0.03 ? 8 : d >= 0 ? 6 : d >= -0.02 ? 4 : 2; }
function tierRunTrend(d) { return d > 0.7 ? 7 : d > 0.2 ? 5 : d >= -0.2 ? 3 : 1; }

function scoreSide(game, side) {
  const ownPitcher = side === "home" ? game.homePitcher : game.awayPitcher;
  const rivalPitcher = side === "home" ? game.awayPitcher : game.homePitcher;
  const ownTeam = side === "home" ? game.homeTeam : game.awayTeam;
  const rivalTeam = side === "home" ? game.awayTeam : game.homeTeam;
  const ownRunMetric = effectivePitcherRunMetric(ownPitcher);
  const rivalRunMetric = effectivePitcherRunMetric(rivalPitcher);
  const matchup = computeOffenseVsPitcherMatchup(ownTeam.offense, rivalPitcher);
  const locationOps = side === "home" ? ownTeam.offense.homeAwayOps : null;
  const seasonOpsProxy = locationOps || ownTeam.offense.splitVsHandOps || ownTeam.offense.seasonOps;
  const splitDiff = seasonOpsProxy - ownTeam.offense.seasonOps;
  const trendDiff = ownTeam.offense.runsLast10 - ownTeam.offense.seasonRunsPerGame;

  const pitcherOwnScore = tierPitcherRunMetric(ownRunMetric) + tierWhip(ownPitcher.whip30) + tierK9(ownPitcher.k9) + tierRest(ownPitcher.restDays);
  const pitcherRivalScore = tierPitcherVulnerability(rivalRunMetric) + tierWhipVulnerability(rivalPitcher.whip30) + tierK9Vulnerability(rivalPitcher.k9) + tierRestVulnerability(rivalPitcher.restDays);
  const offenseScore = tierOpsProxy(seasonOpsProxy) + tierSplitAdvantage(splitDiff) + tierRunTrend(trendDiff) + Math.round(matchup.scorePoints);

  let contextAdjustment = 0;
  const ctx = [];
  const ob = ownTeam.bullpen, rb = rivalTeam.bullpen;
  if (ob.era7 < rb.era7) { contextAdjustment += 3; ctx.push("bullpen_era_mejor:+3"); }
  if (ob.usage48hPitches < rb.usage48hPitches - 20) { contextAdjustment += 2; ctx.push("bullpen_descansado:+2"); }
  if ((rb.fatigue?.score || 0) >= 5) { contextAdjustment += 2; ctx.push("rival_bp_fatigado:+2"); }
  if ((ob.fatigue?.score || 0) >= 5) { contextAdjustment -= 2; ctx.push("propio_bp_fatigado:-2"); }
  if ((rivalTeam.scheduleFatigue?.fatigueScore || 0) >= 4) { contextAdjustment += 2; ctx.push("rival_calendario:+2"); }
  if ((ownTeam.scheduleFatigue?.fatigueScore || 0) >= 4) { contextAdjustment -= 2; ctx.push("propio_calendario:-2"); }
  if (ownTeam.lineup?.confirmed && rivalTeam.lineup?.confirmed) { contextAdjustment += 2; ctx.push("lineups_confirmadas:+2"); }
  if (game.park?.category === "Favorece bateo" && ownTeam.offense.splitVsHandOps > 0.77) { contextAdjustment += 2; ctx.push("parque_bateo:+2"); }
  if (game.park?.category === "Favorece pitcheo" && ownRunMetric < 3.7) { contextAdjustment += 2; ctx.push("parque_pitcheo:+2"); }
  const hvs = ownPitcher.historyVsOpponent;
  if (hvs?.games >= 3 && hvs.era != null) {
    if (hvs.era < 3.0) { contextAdjustment += 2; ctx.push("historial_vs_rival_bueno:+2"); }
    else if (hvs.era > 5.0) { contextAdjustment -= 2; ctx.push("historial_vs_rival_malo:-2"); }
  }
  const formDelta = recentPitcherFormRunDelta(ownPitcher);
  if (formDelta > 0.25) contextAdjustment -= Math.min(Math.round(formDelta * 8), 4);
  else if (formDelta === 0 && Number.isFinite(ownPitcher.recentStartsEra) && ownPitcher.recentStartsEra + 0.5 < ownRunMetric) contextAdjustment += 2;

  return {
    ownRunMetric, rivalRunMetric, matchup,
    pitcherOwnScore, pitcherRivalScore, offenseScore, contextAdjustment,
    rawNoMarket: pitcherOwnScore + pitcherRivalScore + offenseScore + contextAdjustment,
    ctxNotes: ctx,
    inputs: { seasonOpsProxy, splitDiff, trendDiff, formDelta },
  };
}

const src = process.argv[2] || "tmp-mlb.json";
const data = JSON.parse(readFileSync(src, "utf8"));
const today = data.date;
const games = (data.games || []).filter((g) => g.scheduleDate === today || g.officialDate === today);

console.log(`MLB ${today} — ${games.length} partidos\n`);

for (const g of games) {
  const hs = scoreSide(g, "home");
  const as = scoreSide(g, "away");
  const flags = g.mlbContext?.flags || {};
  const baseDq = computeDataQuality(flags, { oddsAvailable: g.oddsAvailable });
  const dq = applyDataQualityPenalties(baseDq, MLB_THRESHOLDS.dataQualityPenalties, flags, "mlb");

  console.log(`▶ ${g.awayTeam.abbreviation} @ ${g.homeTeam.abbreviation} (${g.stadium})`);
  console.log(`  Proyección: ${g.awayTeam.abbreviation} ${g.projections?.awayRuns} | ${g.homeTeam.abbreviation} ${g.projections?.homeRuns} | Total ${g.projections?.totalRuns} (línea ${g.totalsLine}, Δ ${g.projections?.diffVsLine})`);
  console.log(`  Sim MC: homeWin ${((g.simulation?.homeWinProb || 0) * 100).toFixed(1)}% | over ${((g.simulation?.overProb || 0) * 100).toFixed(1)}% | RL home cover ${((g.simulation?.homeCoverProb || 0) * 100).toFixed(1)}%`);
  console.log(`  Parque: ${g.park?.category} runFactor=${g.park?.runFactor} | Clima: ${g.weather?.label || "N/D"} adj=${g.weatherAdjustment?.runAdjust ?? 0}`);
  console.log(`  dataQuality: ${dq.toFixed(2)} (base ${baseDq.toFixed(2)}) | flags: ${JSON.stringify(flags)}`);
  console.log(`  HOME score ${hs.rawNoMarket} = ownPitcher ${hs.pitcherOwnScore} + rivalPitcher ${hs.pitcherRivalScore} + offense ${hs.offenseScore} + context ${hs.contextAdjustment}`);
  console.log(`    abridor ${g.homePitcher.name}: ERA ${g.homePitcher.era30} xFIP ${g.homePitcher.xFip30} eff=${hs.ownRunMetric} WHIP ${g.homePitcher.whip30} K9 ${g.homePitcher.k9} rest ${g.homePitcher.restDays}d`);
  console.log(`    vs ${g.awayPitcher.name}: eff=${hs.rivalRunMetric} | matchup runΔ=${hs.matchup.runDelta} pts=${hs.matchup.scorePoints}`);
  console.log(`  AWAY score ${as.rawNoMarket} = ownPitcher ${as.pitcherOwnScore} + rivalPitcher ${as.pitcherRivalScore} + offense ${as.offenseScore} + context ${as.contextAdjustment}`);
  console.log(`    abridor ${g.awayPitcher.name}: ERA ${g.awayPitcher.era30} xFIP ${g.awayPitcher.xFip30} eff=${as.ownRunMetric}`);
  console.log(`    vs ${g.homePitcher.name}: eff=${as.rivalRunMetric} | bullpen ERA7 H/A ${g.homeTeam.bullpen?.era7}/${g.awayTeam.bullpen?.era7} fatiga ${g.homeTeam.bullpen?.fatigue?.score}/${g.awayTeam.bullpen?.fatigue?.score}`);
  console.log("");
}
