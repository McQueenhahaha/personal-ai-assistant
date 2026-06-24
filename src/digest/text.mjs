export function compactLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
