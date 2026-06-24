import fs from "node:fs";
import path from "node:path";

export function projectRoot() {
  return path.resolve(process.env.PROJECT_ROOT || process.cwd());
}

export function loadEnv(file = ".env") {
  const envPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(envPath)) return false;

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    let value = normalized.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  return true;
}

export function envList(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(/[|,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function resolveFromCwd(inputPath) {
  const value = inputPath || ".";
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}
