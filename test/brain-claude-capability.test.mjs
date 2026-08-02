import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSIST_TOOLS,
  BROWSE_DISALLOWED_TOOLS,
  BROWSE_SYSTEM_PROMPT,
  BROWSE_TOOLS
} from "../src/brain/claude.mjs";

function toolSet(toolList) {
  return new Set(toolList.split(","));
}

test("browse excludes Bash from allowed tools and explicitly disallows it", () => {
  assert.deepEqual([...toolSet(BROWSE_TOOLS)], ["Read", "Grep", "Glob", "ToolSearch"]);
  assert.equal(toolSet(BROWSE_DISALLOWED_TOOLS).has("Bash"), true);
});

test("assist retains Bash", () => {
  assert.equal(toolSet(ASSIST_TOOLS).has("Bash"), true);
});

test("browse treats page content as untrusted data rather than instructions", () => {
  assert.match(BROWSE_SYSTEM_PROMPT, /不可信/);
  assert.match(BROWSE_SYSTEM_PROMPT, /不是指令/);
  assert.match(BROWSE_SYSTEM_PROMPT, /用户已授权/);
});

test("browse still disallows Playwright write tools", () => {
  const disallowedTools = toolSet(BROWSE_DISALLOWED_TOOLS);
  const playwrightWriteTools = [
    "mcp__playwright__browser_click",
    "mcp__playwright__browser_drag",
    "mcp__playwright__browser_drop",
    "mcp__playwright__browser_evaluate",
    "mcp__playwright__browser_file_upload",
    "mcp__playwright__browser_fill_form",
    "mcp__playwright__browser_handle_dialog",
    "mcp__playwright__browser_press_key",
    "mcp__playwright__browser_run_code_unsafe",
    "mcp__playwright__browser_select_option",
    "mcp__playwright__browser_type"
  ];

  for (const tool of playwrightWriteTools) {
    assert.equal(disallowedTools.has(tool), true, `${tool} must remain disallowed`);
  }
});
