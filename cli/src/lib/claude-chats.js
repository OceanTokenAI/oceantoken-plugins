import fs from "node:fs";
import path from "node:path";

// Claude Code keeps each chat as a JSONL transcript under <config dir>/projects/ and sends
// the whole history again on every turn. A reply that came through OceanToken can carry
// `provider_specific_fields` on a content block (gateways before 2026-10-31 wrote it as
// null on every tool call), and Anthropic refuses such a history once the chat continues
// on the user's own plan: "tool_use.provider_specific_fields: Extra inputs are not
// permitted" (board 2026-10-30). `unuse claude-code` takes the field out of every chat,
// after copying each chat it changes to a backup folder.
//
// Transcripts run to hundreds of megabytes, so they are handled as bytes and only the
// lines that mention the field are parsed.

const FIELD = "provider_specific_fields";
const NEWLINE = 0x0a;
const RETRIES = 5;

/** Every transcript under projects/, subagent transcripts included. */
function transcripts(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return transcripts(file);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [file] : [];
  });
}

/** A transcript line without the field, with how many blocks had it; null when none did. */
export function cleanLine(line) {
  if (!line.includes(FIELD)) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return null;
  let blocks = 0;
  for (const block of content) {
    if (block && typeof block === "object" && FIELD in block) {
      delete block[FIELD];
      blocks++;
    }
  }
  return blocks ? { line: JSON.stringify(entry), blocks } : null;
}

/** The transcript without the field, or null when it has none. Takes and returns bytes. */
export function cleanTranscript(bytes) {
  if (!bytes.includes(FIELD)) return null;
  const parts = [];
  let blocks = 0;
  let kept = 0; // start of the bytes not copied to parts yet
  for (let start = 0; start < bytes.length; ) {
    const end = bytes.indexOf(NEWLINE, start);
    const stop = end === -1 ? bytes.length : end;
    const raw = bytes.subarray(start, stop);
    if (raw.includes(FIELD)) {
      const res = cleanLine(raw.toString("utf8"));
      if (res) {
        parts.push(bytes.subarray(kept, start), Buffer.from(res.line, "utf8"));
        kept = stop;
        blocks += res.blocks;
      }
    }
    start = stop + 1;
  }
  if (!blocks) return null;
  parts.push(bytes.subarray(kept));
  return { bytes: Buffer.concat(parts), blocks };
}

const sameFile = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs;

/** The chat a transcript belongs to: projects/<project>/<id>.jsonl, or a subagent's under projects/<project>/<id>/. */
const chatOf = (root, file) => path.relative(root, file).split(path.sep).slice(0, 2).join("/").replace(/\.jsonl$/, "");

/**
 * Transcripts that would fail on the user's own plan: [{ file, chat, blocks }]. With `backupDir`, each
 * one is copied there (same path below projects/; the folder is made only when needed) and
 * rewritten in place. A chat Claude Code appends to meanwhile is read again, so a line it
 * adds while this runs is not lost.
 */
export function cleanChats(claudeDir, { backupDir = null } = {}) {
  const root = path.join(claudeDir, "projects");
  const changed = [];
  for (const file of transcripts(root)) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      const before = fs.statSync(file);
      const bytes = fs.readFileSync(file);
      const res = cleanTranscript(bytes);
      if (!res) break;
      if (!backupDir) {
        changed.push({ file, chat: chatOf(root, file), blocks: res.blocks });
        break;
      }
      // The backup is what was cleaned, so it is the chat as it was just before.
      const copy = path.join(backupDir, "projects", path.relative(root, file));
      fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
      fs.writeFileSync(copy, bytes, { mode: 0o600 });
      const tmp = `${file}.tmp-oceantoken-${process.pid}`;
      fs.writeFileSync(tmp, res.bytes, { mode: before.mode & 0o777 });
      if (!sameFile(before, fs.statSync(file))) {
        fs.rmSync(tmp, { force: true });
        if (attempt === RETRIES) throw new Error(`${file} kept changing while it was cleaned; run unuse again`);
        continue;
      }
      fs.renameSync(tmp, file);
      changed.push({ file, chat: chatOf(root, file), blocks: res.blocks });
      break;
    }
  }
  return changed;
}
