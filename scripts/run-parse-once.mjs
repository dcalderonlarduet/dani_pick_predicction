import fs from "fs";
import { parsePublicSplitsHtml } from "../src/providers/public-splits.js";

const htmlPath = process.argv[2] || "fixtures/dk-splits-full.html";
const html = fs.readFileSync(htmlPath, "utf8");
const result = parsePublicSplitsHtml(html, { sport: "MLB" });
const out = {
  ok: Array.isArray(result?.games) && result.games.length > 0,
  count: result?.games?.length ?? 0,
  games: result?.games,
  meta: result?.meta,
};
fs.writeFileSync("last-json-only.json", JSON.stringify(out));
console.log(JSON.stringify(out));
