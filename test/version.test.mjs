import { test } from "node:test";
import assert from "node:assert/strict";

import { readCodeVersion } from "../src/version.mjs";

function fakeGit(outputs) {
  const calls = [];
  const execFileImpl = async (file, args) => {
    calls.push([file, ...args].join(" "));
    const output = outputs[args[0]];
    if (output instanceof Error) throw output;
    return { stdout: output };
  };
  return { calls, execFileImpl };
}

test("readCodeVersion reports the short HEAD hash", async () => {
  const git = fakeGit({ "rev-parse": "622fb5c\n", status: "" });

  assert.equal(await readCodeVersion({ cwd: "repo", execFileImpl: git.execFileImpl }), "622fb5c");
  assert.deepEqual(git.calls, ["git rev-parse --short HEAD", "git status --porcelain --untracked-files=no"]);
});

test("readCodeVersion flags uncommitted tracked changes", async () => {
  const git = fakeGit({ "rev-parse": "622fb5c\n", status: " M src/brain/lease.mjs\n" });

  assert.equal(await readCodeVersion({ execFileImpl: git.execFileImpl }), "622fb5c（含未提交改动）");
});

test("readCodeVersion returns null outside a git checkout instead of throwing", async () => {
  const git = fakeGit({ "rev-parse": new Error("fatal: not a git repository") });

  assert.equal(await readCodeVersion({ execFileImpl: git.execFileImpl }), null);
});
