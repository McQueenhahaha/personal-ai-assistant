import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  envList,
  envNumber,
  loadEnv,
  projectRoot,
  resolveFromCwd,
  timestampForFile
} from "../src/env.mjs";

let keyCounter = 0;

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function uniqueKey(label) {
  keyCounter += 1;
  return `PAI_TEST_${process.pid}_${Date.now()}_${keyCounter}_${label}`;
}

function restoreEnvAfter(t, keys) {
  const originals = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      const original = originals.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });
}

test("loadEnv parses env files without overwriting existing keys", (t) => {
  const root = makeTempRoot(t);
  const plainKey = uniqueKey("PLAIN");
  const doubleQuotedKey = uniqueKey("DOUBLE");
  const singleQuotedKey = uniqueKey("SINGLE");
  const exportedKey = uniqueKey("EXPORT");
  const existingKey = uniqueKey("EXISTING");
  const keys = [plainKey, doubleQuotedKey, singleQuotedKey, exportedKey, existingKey];
  restoreEnvAfter(t, keys);

  process.env[existingKey] = "kept";
  const envFile = path.join(root, ".env");
  fs.writeFileSync(
    envFile,
    [
      "# comment",
      "",
      `${plainKey}=plain`,
      `${doubleQuotedKey}="quoted value"`,
      `${singleQuotedKey}='single quoted'`,
      `export ${exportedKey}=exported`,
      `${existingKey}=from-file`,
      "NOT_A_PAIR"
    ].join("\n"),
    "utf8"
  );

  assert.equal(loadEnv(envFile), true);
  assert.equal(process.env[plainKey], "plain");
  assert.equal(process.env[doubleQuotedKey], "quoted value");
  assert.equal(process.env[singleQuotedKey], "single quoted");
  assert.equal(process.env[exportedKey], "exported");
  assert.equal(process.env[existingKey], "kept");
  assert.equal(loadEnv(path.join(root, "missing.env")), false);
});

test("envList splits comma and pipe separated values and falls back for empty values", (t) => {
  const listKey = uniqueKey("LIST");
  const emptyKey = uniqueKey("EMPTY");
  restoreEnvAfter(t, [listKey, emptyKey]);
  process.env[listKey] = "alpha, beta|gamma,, ";
  process.env[emptyKey] = "";

  assert.deepEqual(envList(listKey), ["alpha", "beta", "gamma"]);
  assert.deepEqual(envList(emptyKey, ["fallback"]), ["fallback"]);
  assert.deepEqual(envList(uniqueKey("MISSING"), ["fallback"]), ["fallback"]);
});

test("envNumber returns parsed numbers or fallback for invalid and missing values", (t) => {
  const numberKey = uniqueKey("NUMBER");
  const invalidKey = uniqueKey("INVALID_NUMBER");
  restoreEnvAfter(t, [numberKey, invalidKey]);
  process.env[numberKey] = "42.5";
  process.env[invalidKey] = "not-a-number";

  assert.equal(envNumber(numberKey, 7), 42.5);
  assert.equal(envNumber(invalidKey, 7), 7);
  assert.equal(envNumber(uniqueKey("MISSING_NUMBER"), 7), 7);
});

test("projectRoot uses PROJECT_ROOT when set and falls back to process.cwd()", (t) => {
  restoreEnvAfter(t, ["PROJECT_ROOT"]);
  const configuredRoot = path.join(os.tmpdir(), "pai-project-root", "..", "pai-project-root-final");

  process.env.PROJECT_ROOT = configuredRoot;
  assert.equal(projectRoot(), path.resolve(configuredRoot));

  delete process.env.PROJECT_ROOT;
  assert.equal(projectRoot(), path.resolve(process.cwd()));
});

test("resolveFromCwd resolves relative paths against process.cwd()", () => {
  assert.equal(
    resolveFromCwd(path.join("relative", "file.txt")),
    path.resolve(process.cwd(), "relative", "file.txt")
  );
});

test("timestampForFile produces deterministic filename-safe timestamps", () => {
  const timestamp = timestampForFile(new Date("2024-01-02T03:04:05.006Z"));

  assert.equal(timestamp, "2024-01-02T03-04-05-006Z");
  assert.doesNotMatch(timestamp, /[:.]/);
});
