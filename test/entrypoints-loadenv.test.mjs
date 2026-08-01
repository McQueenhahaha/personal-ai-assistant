import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY_GUARD = /import\.meta\.url\s*===\s*pathToFileURL\(/;
const LOAD_ENV_CALL = /\bloadEnv\s*\(/;
const LOAD_ENV_EXEMPTIONS = new Map([
  [
    "satellite/mac-agent.mjs",
    "Mac satellite agent uses only fixed paths and process arguments; it does not read process.env."
  ]
]);

function listMjsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listMjsFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [entryPath] : [];
  });
}

test("guarded entrypoints load .env before running", () => {
  const entrypoints = ["src", "satellite"]
    .flatMap((directory) => listMjsFiles(path.join(REPO_ROOT, directory)))
    .map((file) => ({ file, source: fs.readFileSync(file, "utf8") }))
    .filter(({ source }) => ENTRY_GUARD.test(source));
  const relativeEntrypoints = new Set(
    entrypoints.map(({ file }) => path.relative(REPO_ROOT, file).replaceAll(path.sep, "/"))
  );

  assert.ok(entrypoints.length > 0, "expected to find guarded entrypoints");
  for (const exemptFile of LOAD_ENV_EXEMPTIONS.keys()) {
    assert.ok(relativeEntrypoints.has(exemptFile), `stale loadEnv exemption: ${exemptFile}`);
  }

  for (const { file, source } of entrypoints) {
    const relativeFile = path.relative(REPO_ROOT, file).replaceAll(path.sep, "/");
    if (LOAD_ENV_EXEMPTIONS.has(relativeFile)) continue;
    assert.match(source, LOAD_ENV_CALL, `${relativeFile} must call loadEnv()`);
  }
});
