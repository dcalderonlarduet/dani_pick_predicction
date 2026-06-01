export function normalizeCommenceTime(value) {
  if (value == null || value === "") return "";
  const text = String(value);
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return text.slice(0, 19);
}

export function scheduleDateFromIso(value) {
  return normalizeCommenceTime(value).slice(0, 10);
}
