import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sendCanvasUnauthorizedAlert,
  sendTokenExpiryAlertIfNeeded
} from "../src/canvas/token-alert.mjs";

test("Canvas token alerts deduplicate each level once per local day", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-token-alert-"));
  const stateFile = path.join(tempDir, "state.json");
  const messages = [];
  const send = async (message) => messages.push(message);
  const nowMs = Date.parse("2026-10-15T01:00:00Z");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(await sendTokenExpiryAlertIfNeeded({
    expiresAtIso: "2026-10-29",
    nowMs,
    send,
    stateFile,
    canvasBaseUrl: "https://canvas.example.edu/"
  }), true);
  assert.equal(await sendTokenExpiryAlertIfNeeded({
    expiresAtIso: "2026-10-29",
    nowMs: nowMs + 3600000,
    send,
    stateFile,
    canvasBaseUrl: "https://canvas.example.edu/"
  }), false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes("Approved Integrations → + New Access Token"), true);
  assert.equal(messages[0].includes("https://canvas.example.edu/profile/settings"), true);

  assert.equal(await sendCanvasUnauthorizedAlert({
    nowMs,
    send,
    stateFile,
    canvasBaseUrl: "https://canvas.example.edu/"
  }), true);
  assert.equal(await sendCanvasUnauthorizedAlert({
    nowMs,
    send,
    stateFile,
    canvasBaseUrl: "https://canvas.example.edu/"
  }), false);
  assert.equal(messages.length, 2);
});

test("Canvas token alerts show a neutral placeholder when CANVAS_BASE_URL is missing", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-token-alert-placeholder-"));
  const stateFile = path.join(tempDir, "state.json");
  const messages = [];
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  await sendCanvasUnauthorizedAlert({
    nowMs: Date.parse("2026-10-15T01:00:00Z"),
    send: async (message) => messages.push(message),
    stateFile,
    canvasBaseUrl: ""
  });

  assert.match(messages[0], /https:\/\/<your-school>\.instructure\.com\/profile\/settings/);
  assert.match(messages[0], /\.env 配置 CANVAS_BASE_URL/);
});
