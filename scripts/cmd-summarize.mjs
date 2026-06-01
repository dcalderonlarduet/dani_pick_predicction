import { spawnSync } from "child_process";
import fs from "fs";

function runNode(args, env = {}) {
  return spawnSync("node", args, {
    encoding: "utf8",
    maxBuffer: 25 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

const parserRun = runNode(["scripts/test-public-splits-parse.mjs"]);
let parser = null;
try {
  parser = JSON.parse(parserRun.stdout);
} catch (e) {
  parser = { parseError: String(e), stdoutHead: parserRun.stdout?.slice(0, 500) };
}

const smokeRun = runNode(["scripts/smoke-e2e.mjs"], {
  SMOKE_BASE_URL: process.env.SMOKE_BASE_URL || "http://host.docker.internal:3000",
});
let smoke = null;
try {
  smoke = JSON.parse(smokeRun.stdout);
} catch (e) {
  smoke = {
    parseError: String(e),
    stdoutHead: smokeRun.stdout?.slice(0, 800),
    stderrHead: smokeRun.stderr?.slice(0, 800),
    exit: smokeRun.status,
  };
}

const eps = smoke?.endpoints || smoke?.results || [];
const all200 =
  Array.isArray(eps) && eps.length > 0 ? eps.every((e) => e.status === 200) : null;
const publicSplits = smoke?.["public-splits"] || smoke?.publicSplits;

const compact = {
  parser,
  parserOk: parser?.ok === true,
  smokeOk: smoke?.ok === true,
  allEndpoints200: all200,
  endpoints: Array.isArray(eps)
    ? eps.map((e) => ({ path: e.path || e.url || e.name, status: e.status }))
    : null,
  publicSplitsState: publicSplits?.state ?? publicSplits?.status,
  publicSplitsMessage: publicSplits?.message ?? publicSplits?.msg,
  smokeParseError: smoke?.parseError,
  smokeExit: smokeRun.status,
  parserExit: parserRun.status,
};

fs.writeFileSync("cmd-summary-compact.json", JSON.stringify(compact, null, 2));
process.stdout.write(JSON.stringify(compact));
