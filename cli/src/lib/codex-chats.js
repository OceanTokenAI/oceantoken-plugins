import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { which as realWhich } from "./run.js";
import { openDatabase, sqlValue } from "./sqlite.js";

// `use codex --move-chats` / `unuse codex --move-chats`: move the chats Codex already has
// between the ChatGPT plan ("openai") and OceanToken ("oceantoken").
//
// What Codex reads when it reopens a chat (checked against Codex 0.163, the engine of the
// ChatGPT desktop app): the provider and model stored for the chat in the `threads` table
// of CODEX_HOME/state_<n>.sqlite. The provider recorded in the chat file's first line is
// not read once the chat is in that table, so the chat files are left alone when moving
// to OceanToken.
//
// Hidden reasoning in a chat is encrypted by the account that produced it. OceanToken
// copes with reasoning made by a ChatGPT plan (it drops what its upstream cannot read), but
// a ChatGPT plan rejects reasoning made through OceanToken ("The encrypted content ... could
// not be verified"). So moving back blanks that reasoning in the chat files: each such line
// is rewritten to an item Codex skips, padded with spaces to its exact byte length, so
// every byte offset Codex keeps into the file (segment pointers, its display cache) stays
// right. The visible conversation is not touched.

export const OPENAI = "openai";
export const OCEANTOKEN = "oceantoken";
/** The payload type a blanked reasoning line gets; Codex skips item types it does not know. */
export const DROPPED_TYPE = "oceantoken_dropped_reasoning";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/;

/** Codex's chat database: the newest state_<n>.sqlite in CODEX_HOME, or null. */
export function stateDbFile(codexHome) {
  let names;
  try {
    names = fs.readdirSync(codexHome);
  } catch {
    return null;
  }
  const dbs = names
    .map((n) => /^state_(\d+)\.sqlite$/.exec(n))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return dbs.length ? path.join(codexHome, dbs[0][0]) : null;
}

/**
 * Codex processes that could be writing the chats: the ChatGPT / Codex desktop app and any
 * `codex` program (CLI, IDE extension, app-server daemon). Null when that cannot be checked.
 * `probe(cmd, args)` runs a read-only command and returns { code, stdout }.
 */
export async function runningCodex(probe, platform = process.platform) {
  if (platform === "win32") {
    const res = await probe("tasklist", ["/FO", "CSV", "/NH"]);
    if (res.code !== 0) return null;
    const names = res.stdout.split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, "").toLowerCase());
    return [...new Set(names.filter((n) => ["chatgpt.exe", "codex.exe"].includes(n)))];
  }
  const res = await probe("ps", ["-axo", "pid=,comm="]);
  if (res.code !== 0) return null;
  const found = [];
  for (const line of res.stdout.split("\n")) {
    const exe = line.trim().replace(/^\d+\s+/, "");
    const base = path.posix.basename(exe);
    const app = exe.includes(".app/") && (base === "ChatGPT" || base === "Codex");
    if (base === "codex" || app) found.push(exe);
  }
  return [...new Set(found)];
}

/** The chats stored with `provider`: [{ id, model, rollout_path }]. */
export function threadsOn(db, provider) {
  return db.all(`SELECT id, model, rollout_path FROM threads WHERE model_provider = ${sqlValue(provider)} ORDER BY id`);
}

/**
 * Which ChatGPT-plan chats can move to OceanToken. A chat keeps its model under OceanToken's
 * name for it (gpt-6-astra -> openai/gpt-6-astra): Codex treats the two as the same model, so
 * the chat continues as it was. A chat whose model OceanToken does not sell stays where it
 * is; a chat with no model yet moves as it is. `available` is the set of model ids the key
 * can use, or null when it could not be read (then only gpt-* models move).
 */
export function planToOceanToken(rows, available) {
  const move = [];
  const keep = [];
  for (const row of rows) {
    const model = row.model;
    if (model === null || model === undefined || model === "") {
      move.push({ id: row.id, model, to: model });
      continue;
    }
    const target = model.includes("/") ? model : `openai/${model}`;
    const sold = available ? available.has(target) : /^openai\/gpt-/.test(target);
    if (sold) move.push({ id: row.id, model, to: target });
    else keep.push({ id: row.id, model });
  }
  return { move, keep };
}

/**
 * Which OceanToken chats can move to the ChatGPT plan: the model a chat had before `use`
 * moved it, else openai/<name> -> <name>. A chat on another publisher's model
 * (deepseek/..., anthropic/...) stays on OceanToken: a ChatGPT plan cannot run it.
 */
export function planToOpenAI(rows, saved = {}) {
  const move = [];
  const keep = [];
  for (const row of rows) {
    const model = row.model;
    const before = saved[row.id];
    if (before && "model" in before) move.push({ id: row.id, model, to: before.model });
    else if (model === null || model === undefined || model === "") move.push({ id: row.id, model, to: model });
    else if (model.startsWith("openai/")) move.push({ id: row.id, model, to: model.slice("openai/".length) });
    else keep.push({ id: row.id, model });
  }
  return { move, keep };
}

/** Point chats at another provider and model, in one transaction. */
export function repoint(db, moves, from, to) {
  if (!moves.length) return;
  const statements = moves.map(
    (m) =>
      `UPDATE threads SET model_provider = ${sqlValue(to)}, model = ${sqlValue(m.to)} ` +
      `WHERE id = ${sqlValue(m.id)} AND model_provider = ${sqlValue(from)};`,
  );
  db.exec(`BEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;`);
}

/** A consistent copy of the database (works while it is in WAL mode). */
export function backupDatabase(db, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  db.exec(`VACUUM INTO ${sqlValue(target)};`);
}

// -- chat files ----------------------------------------------------------------------------

function zstd(buffer, decompress) {
  const fn = decompress ? zlib.zstdDecompressSync : zlib.zstdCompressSync;
  if (typeof fn === "function") return fn(buffer);
  const bin = realWhich("zstd");
  if (!bin) throw new Error("compressed chat files need Node 22.15 or later, or the zstd command");
  const res = spawnSync(bin, decompress ? ["-d", "-c", "-q"] : ["-c", "-q"], { input: buffer, maxBuffer: 2 ** 31 });
  if (res.status !== 0) throw new Error(`zstd: ${String(res.stderr || res.error?.message || "failed").trim()}`);
  return res.stdout;
}

/** A chat file's path as stored, or its compressed form (Codex compresses old chats). */
export function resolveRollout(file) {
  if (!file) return null;
  if (fs.existsSync(file)) return file;
  if (fs.existsSync(`${file}.zst`)) return `${file}.zst`;
  return null;
}

export const readRollout = (file) => {
  const raw = fs.readFileSync(file);
  return file.endsWith(".zst") ? zstd(raw, true) : raw;
};

/** Replace a chat file, keeping its compression, permissions and modification time. */
export function writeRollout(file, content) {
  const st = fs.statSync(file);
  const tmp = `${file}.tmp-oceantoken-${process.pid}`;
  fs.writeFileSync(tmp, file.endsWith(".zst") ? zstd(content, false) : content, { mode: st.mode & 0o777 });
  fs.renameSync(tmp, file);
  fs.utimesSync(file, st.atimeMs / 1000, st.mtimeMs / 1000);
}

const ownId = (file) => (path.basename(file).match(UUID) ?? []).at(-1) ?? null;

/** Every chat file under CODEX_HOME by its own id (the last uuid in its name). */
export function rolloutIndex(codexHome) {
  const index = new Map();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 6) walk(p, depth + 1);
      else if (e.isFile() && ROLLOUT.test(e.name)) {
        const id = ownId(p);
        if (id && (!index.has(id) || !p.endsWith(".zst"))) index.set(id, p);
      }
    }
  };
  for (const sub of ["sessions", "archived_sessions"]) walk(path.join(codexHome, sub), 0);
  return index;
}

function firstLine(buffer) {
  const end = buffer.indexOf(0x0a);
  try {
    return JSON.parse(buffer.subarray(0, end < 0 ? buffer.length : end).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The files a chat is made of, oldest first. A long or edited chat is split into segments;
 * each segment's first line names the file it continues (history_base.thread_id).
 * `read(file)` returns the file's content (cached by the caller).
 */
export function rolloutChain(index, rolloutPath, read) {
  const chain = [];
  const seen = new Set();
  let file = resolveRollout(rolloutPath);
  while (file && !seen.has(file) && chain.length < 1000) {
    seen.add(file);
    chain.unshift(file);
    const prev = firstLine(read(file))?.payload?.history_base?.thread_id;
    if (!prev || prev === ownId(file)) break;
    file = index.get(prev) ?? null;
  }
  return chain;
}

const isEncryptedReasoning = (item) => item && item.type === "reasoning" && Boolean(item.encrypted_content);

/** `json` written over exactly `bytes` bytes: spaces before its closing brace (JSON allows them). */
function sameLength(json, bytes) {
  const pad = bytes - Buffer.byteLength(json);
  if (pad < 0 || !json.endsWith("}")) return null;
  return Buffer.from(`${json.slice(0, -1)}${" ".repeat(pad)}}`);
}

/**
 * Blank the reasoning made through OceanToken in one chat file: reasoning items in turns
 * whose model is an OceanToken id (publisher/model, e.g. openai/gpt-5.5). `turnModel` is
 * the model of the turn the file starts in (from the previous segment). Every line keeps
 * its length. Returns { content, blanked, unsafe, turnModel }.
 */
export function blankOceanTokenReasoning(content, turnModel = null) {
  const lines = [];
  let start = 0;
  let blanked = 0;
  let unsafe = 0;
  let model = turnModel;
  while (start <= content.length) {
    let end = content.indexOf(0x0a, start);
    if (end < 0) end = content.length;
    let line = content.subarray(start, end);
    if (line.length) {
      const text = line.toString("utf8");
      if (text.includes('"turn_context"')) {
        try {
          const d = JSON.parse(text);
          if (d.type === "turn_context" && typeof d.payload?.model === "string") model = d.payload.model;
        } catch {
          // not a line Codex wrote; leave it
        }
      } else if (model?.includes("/") && text.includes('"encrypted_content"')) {
        const out = blankLine(text, line.length);
        if (out === null) unsafe += 1;
        else if (out) {
          line = out.line;
          blanked += out.count;
        }
      }
    }
    lines.push(line);
    start = end + 1;
  }
  const changed = blanked > 0;
  const joined = changed ? Buffer.concat(lines.flatMap((l, i) => (i ? [Buffer.from("\n"), l] : [l]))) : content;
  return { content: joined, blanked, unsafe, turnModel: model };
}

/** { line, count } for a line holding OceanToken reasoning, false for none, null when unsafe to edit. */
function blankLine(text, bytes) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return false;
  }
  const payload = d?.payload;
  if (d?.type === "response_item" && isEncryptedReasoning(payload)) {
    const kept = Object.fromEntries(
      Object.entries(d).map(([k, v]) => [k, k === "payload" ? { type: DROPPED_TYPE, id: payload.id ?? null } : v]),
    );
    const line = sameLength(JSON.stringify(kept), bytes);
    return line ? { line, count: 1 } : null;
  }
  if (d?.type === "compacted" && payload && typeof payload === "object") {
    // A compacted history keeps earlier items in arrays; only rewrite a line that
    // round-trips exactly, so no number or escape Codex wrote is changed.
    if (JSON.stringify(d) !== text) return null;
    let count = 0;
    for (const key of ["replacement_history", "guardian_history"]) {
      if (!Array.isArray(payload[key])) continue;
      payload[key] = payload[key].map((item) => {
        if (!isEncryptedReasoning(item)) return item;
        count += 1;
        return { type: DROPPED_TYPE, id: item.id ?? null };
      });
    }
    if (!count) return false;
    const line = sameLength(JSON.stringify(d), bytes);
    return line ? { line, count } : null;
  }
  return false;
}
