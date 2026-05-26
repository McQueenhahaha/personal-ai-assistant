import fs from "node:fs";
import path from "node:path";
import { resolveFromCwd } from "./env.mjs";

const ALLOWED_EXTENSIONS = new Set([".eml", ".md", ".txt"]);

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

function headerValue(content, header) {
  const match = content.match(new RegExp(`^${header}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function compactBody(content) {
  return content
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 5000);
}

function readMailFile(filePath, category) {
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const subject = headerValue(content, "Subject") || path.basename(filePath);
  const from = headerValue(content, "From") || "unknown sender";
  const date = headerValue(content, "Date") || stat.mtime.toISOString();

  return {
    category,
    file: filePath,
    subject,
    from,
    date,
    modifiedAt: stat.mtime.toISOString(),
    body: compactBody(content)
  };
}

export function collectMailDrops({ schoolDir, personalDir, maxFiles }) {
  const sources = [
    { category: "school", dir: resolveFromCwd(schoolDir) },
    { category: "personal", dir: resolveFromCwd(personalDir) }
  ];

  const messages = [];
  for (const source of sources) {
    const files = walkFiles(source.dir)
      .map((file) => ({ file, stat: fs.statSync(file) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, maxFiles);

    for (const { file } of files) {
      try {
        messages.push(readMailFile(file, source.category));
      } catch (error) {
        messages.push({
          category: source.category,
          file,
          subject: `Could not read ${path.basename(file)}`,
          from: "local worker",
          date: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          body: error.message
        });
      }
    }
  }

  return messages;
}
