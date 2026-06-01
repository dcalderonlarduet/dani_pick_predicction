export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

export function percent(value) {
  if (!Number.isFinite(value)) return "N/D";
  return `${Math.round(value * 100)}%`;
}
