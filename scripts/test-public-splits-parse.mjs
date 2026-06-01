import { readFile } from "node:fs/promises";
import { parseDraftKingsSplitsHtml } from "../src/providers/public-splits.js";

const html = await readFile("dk-splits-full.html", "utf8");
const parsed = parseDraftKingsSplitsHtml(html, "mlb");
const sample = parsed.games[0];
const ok =
  parsed.ok &&
  parsed.games.length === 10 &&
  sample?.home === "CIN Reds" &&
  sample?.markets?.moneyline?.pct_tickets_home === 16 &&
  sample?.markets?.moneyline?.pct_money_home === 12;

console.log(
  JSON.stringify(
    {
      ok,
      count: parsed.games.length,
      sample: {
        home: sample?.home,
        away: sample?.away,
        ml: sample?.markets?.moneyline,
      },
    },
    null,
    2
  )
);
process.exit(ok ? 0 : 1);
