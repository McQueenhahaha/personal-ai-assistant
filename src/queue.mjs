import fs from "node:fs";
import path from "node:path";
import { resolveFromCwd, timestampForFile } from "./env.mjs";

const TASK_EXTENSIONS = new Set([".json", ".txt", ".md"]);

export function queueDirs(inboxPath) {
  const inbox = resolveFromCwd(inboxPath);
  const root = path.dirname(inbox);
  return {
    root,
    inbox,
    processing: path.join(root, "processing"),
    outbox: path.join(root, "outbox"),
    done: path.join(root, "done"),
    failed: path.join(root, "failed")
  };
}

export function ensureQueue(inboxPath) {
  const dirs = queueDirs(inboxPath);
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

export function listPendingTasks(inboxPath) {
  const dirs = ensureQueue(inboxPath);
  return fs
    .readdirSync(dirs.inbox, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => TASK_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const file = path.join(dirs.inbox, entry.name);
      return {
        file,
        name: entry.name,
        stat: fs.statSync(file)
      };
    })
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
}

export function claimTask(task, inboxPath) {
  const dirs = ensureQueue(inboxPath);
  const claimed = path.join(dirs.processing, `${timestampForFile()}-${task.name}`);
  fs.renameSync(task.file, claimed);
  return claimed;
}

export function readTask(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (path.extname(file).toLowerCase() === ".json") {
    const data = JSON.parse(raw || "{}");
    return {
      raw,
      id: data.id || path.basename(file),
      title: data.title || data.subject || path.basename(file),
      priority: data.priority || "normal",
      source: data.source || "queue",
      taskType: data.taskType || data.type || "general",
      prompt: data.prompt || data.body || data.content || raw,
      metadata: data
    };
  }

  return {
    raw,
    id: path.basename(file),
    title: path.basename(file),
    priority: "normal",
    source: "queue",
    taskType: "general",
    prompt: raw,
    metadata: {}
  };
}

export function writeResult({ inboxPath, taskFile, task, result, status = "done" }) {
  const dirs = ensureQueue(inboxPath);
  const stem = path.basename(taskFile).replace(/\.[^.]+$/, "");
  const outFile = path.join(dirs.outbox, `${stem}.result.txt`);
  const doneFile = path.join(dirs[status], path.basename(taskFile));

  const header = [
    `Task: ${task.title}`,
    `ID: ${task.id}`,
    `Source: ${task.source}`,
    `Priority: ${task.priority}`,
    `Completed: ${new Date().toISOString()}`,
    ""
  ].join("\n");

  fs.writeFileSync(outFile, `${header}${result.trim()}\n`, "utf8");
  fs.renameSync(taskFile, doneFile);
  return outFile;
}

export function writeFailure({ inboxPath, taskFile, task, error }) {
  const dirs = ensureQueue(inboxPath);
  const stem = path.basename(taskFile).replace(/\.[^.]+$/, "");
  const outFile = path.join(dirs.outbox, `${stem}.error.txt`);
  const failedFile = path.join(dirs.failed, path.basename(taskFile));
  fs.writeFileSync(
    outFile,
    [
      `Task: ${task?.title || path.basename(taskFile)}`,
      `Failed: ${new Date().toISOString()}`,
      "",
      error.stack || error.message || String(error),
      ""
    ].join("\n"),
    "utf8"
  );
  fs.renameSync(taskFile, failedFile);
  return outFile;
}

export function createTask({ inboxPath, title, prompt, taskType = "general", source = "manual", priority = "normal" }) {
  const dirs = ensureQueue(inboxPath);
  const safeTitle = title.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "task";
  const file = path.join(dirs.inbox, `${timestampForFile()}-${safeTitle}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        id: path.basename(file, ".json"),
        title,
        taskType,
        source,
        priority,
        prompt,
        createdAt: new Date().toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
  return file;
}
