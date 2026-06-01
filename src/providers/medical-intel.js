import { readFile } from "node:fs/promises";

import { canonicalName } from "./shared/tennis-normalizers.js";

const MEDICAL_ORDER = {
  none: 0,
  watch: 1,
  concern: 2,
  red: 3,
};

function maxMedicalLevel(currentLevel, incomingLevel) {
  return MEDICAL_ORDER[incomingLevel] > MEDICAL_ORDER[currentLevel] ? incomingLevel : currentLevel;
}

async function loadJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function inferRetirementSignal(match) {
  const status = String(match.event_status || match.status || "").toLowerCase();
  if (status.includes("retired") || status.includes("retirement")) {
    return { level: "red", note: "Retiro reciente detectado en resultados." };
  }
  if (status.includes("walkover") || status.includes("w/o")) {
    return { level: "concern", note: "Walkover o retirada administrativa reciente." };
  }
  return null;
}

function inferScheduleSignal(sameDayMatches, category) {
  if (sameDayMatches >= 2 && category.includes("Doubles")) {
    return {
      level: "watch",
      note: "Carga del mismo dia por combinar singles y dobles o varias rondas.",
    };
  }
  return null;
}

function inferInactivitySignal(inactivityDays) {
  if (inactivityDays >= 70) {
    return { level: "concern", note: "Paron largo sin competir; riesgo alto de ritmo y estado fisico." };
  }
  if (inactivityDays >= 35) {
    return { level: "watch", note: "Mas de cinco semanas sin competir." };
  }
  return null;
}

function composeMedicalNotes(notes) {
  const unique = [...new Set(notes.filter(Boolean))];
  return unique.join(" ");
}

export async function applyMedicalIntel(slate, runtime) {
  const manualPayload = await loadJsonIfExists(runtime.medical.signalsFile);
  const manualSignals = Array.isArray(manualPayload?.signals) ? manualPayload.signals : [];
  const sameDayCounter = new Map();

  for (const match of slate.matches) {
    for (const participant of match.participants) {
      const key = canonicalName(participant.name);
      sameDayCounter.set(key, (sameDayCounter.get(key) || 0) + 1);
    }
  }

  for (const match of slate.matches) {
    for (const participant of match.participants) {
      let level = participant.medical?.level || "none";
      const notes = [];
      const sources = [];

      for (const recentMatch of participant.providerContext?.recentMatches || []) {
        const retirementSignal = inferRetirementSignal(recentMatch);
        if (retirementSignal) {
          level = maxMedicalLevel(level, retirementSignal.level);
          notes.push(retirementSignal.note);
          sources.push("recent-results");
        }
      }

      const sameDaySignal = inferScheduleSignal(sameDayCounter.get(canonicalName(participant.name)) || 0, match.category);
      if (sameDaySignal) {
        level = maxMedicalLevel(level, sameDaySignal.level);
        notes.push(sameDaySignal.note);
        sources.push("schedule-load");
      }

      const inactivitySignal = inferInactivitySignal(participant.inactivityDays);
      if (inactivitySignal) {
        level = maxMedicalLevel(level, inactivitySignal.level);
        notes.push(inactivitySignal.note);
        sources.push("inactivity");
      }

      for (const signal of manualSignals) {
        if (canonicalName(signal.target) !== canonicalName(participant.name)) continue;
        level = maxMedicalLevel(level, signal.level || "watch");
        notes.push(signal.note || "");
        sources.push(signal.source || "manual");
      }

      participant.medical = {
        level,
        note: composeMedicalNotes([participant.medical?.note, ...notes]) || "Sin alertas medicas verificadas.",
        sources,
      };
    }
  }

  const manualCoverageBoost = manualSignals.length ? 0.2 : 0;
  slate.coverage.medical = Math.min(0.92, Math.max(slate.coverage.medical || 0.35, 0.45 + manualCoverageBoost));
  slate.stalenessMinutes.medical = manualSignals.length ? 30 : 180;

  const provider = slate.providerManifest.providers.find((item) => item.id === "medical-intel");
  if (provider) {
    provider.status = manualSignals.length ? "hybrid" : "rules-only";
    provider.notes = manualSignals.length
      ? "Se aplicaron reglas automaticas y overrides manuales."
      : "Solo reglas automaticas; para precision real conviene aportar overrides manuales.";
  }

  return slate;
}
