import { readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

function parseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const separator = trimmed.indexOf("=");
  if (separator < 0) return null;

  const key = trimmed.slice(0, separator).trim();
  if (!key) return null;

  let value = trimmed.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

export function loadLocalEnv() {
  if (loaded) return;
  loaded = true;

  try {
    const envPath = path.join(process.cwd(), ".env");
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (process.env[parsed.key] == null || process.env[parsed.key] === "") {
        process.env[parsed.key] = parsed.value;
      }
    }
  } catch {
    // .env is optional when the process already received vars from Docker or the shell.
  }
}

loadLocalEnv();
