import { readIfExists, writeFileSafely } from "./fsutil.js";

/** Strip // and /* *\/ comments and trailing commas, leaving strings alone. */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse a config file. `strict` is false when the file only parses once comments or
 * trailing commas are removed: rewriting it would drop the user's comments.
 */
export function parseConfig(text) {
  if (text.trim() === "") return { data: {}, strict: true };
  try {
    return { data: JSON.parse(text), strict: true };
  } catch {
    return { data: JSON.parse(stripJsonc(text)), strict: false };
  }
}

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function snippet(keyPath, entry) {
  let value = entry;
  for (const key of [...keyPath].reverse()) value = { [key]: value };
  return JSON.stringify(value, null, 2);
}

/**
 * Set data[keyPath] = entry in a JSON config file, creating the file and parents as needed.
 *
 * Returns { status: created | updated | unchanged | manual, snippet? }. "manual" means the
 * file could not be rewritten safely (comments, or a non-object in the way); the caller
 * shows the snippet for the user to paste instead.
 */
export function upsertJsonEntry(file, keyPath, entry, { dryRun = false, secret = false, init = {} } = {}) {
  const text = readIfExists(file);
  let data;
  if (text === null) {
    data = { ...init };
  } else {
    let parsed;
    try {
      parsed = parseConfig(text);
    } catch {
      return { status: "manual", reason: "the file is not valid JSON", snippet: snippet(keyPath, entry) };
    }
    if (!parsed.strict) {
      return { status: "manual", reason: "the file has comments, so it was left untouched", snippet: snippet(keyPath, entry) };
    }
    data = parsed.data;
    if (!isRecord(data)) {
      return { status: "manual", reason: "the file is not a JSON object", snippet: snippet(keyPath, entry) };
    }
  }
  let parent = data;
  for (const key of keyPath.slice(0, -1)) {
    if (parent[key] === undefined) parent[key] = {};
    if (!isRecord(parent[key])) {
      return { status: "manual", reason: `"${key}" is not an object`, snippet: snippet(keyPath, entry) };
    }
    parent = parent[key];
  }
  const last = keyPath[keyPath.length - 1];
  const before = parent[last];
  if (JSON.stringify(before) === JSON.stringify(entry)) return { status: "unchanged" };
  parent[last] = entry;
  if (!dryRun) writeFileSafely(file, `${JSON.stringify(data, null, 2)}\n`, { secret });
  return { status: text === null ? "created" : before === undefined ? "added" : "updated" };
}

/** Remove data[keyPath] from a JSON config file. Returns { status: removed | absent | manual }. */
export function removeJsonEntry(file, keyPath, { dryRun = false } = {}) {
  const text = readIfExists(file);
  if (text === null) return { status: "absent" };
  let parsed;
  try {
    parsed = parseConfig(text);
  } catch {
    return { status: "manual", reason: "the file is not valid JSON" };
  }
  let parent = parsed.data;
  for (const key of keyPath.slice(0, -1)) {
    if (!isRecord(parent?.[key])) return { status: "absent" };
    parent = parent[key];
  }
  const last = keyPath[keyPath.length - 1];
  if (!isRecord(parent) || !(last in parent)) return { status: "absent" };
  if (!parsed.strict) return { status: "manual", reason: "the file has comments, so it was left untouched" };
  delete parent[last];
  if (!dryRun) writeFileSafely(file, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return { status: "removed" };
}

/**
 * Apply `mutate(data)` to a JSON config object in one write, so the backup taken by
 * writeFileSafely is the file as it was before this run. `mutate` changes `data` in
 * place. Returns { status: created | updated | unchanged | manual, reason? }.
 */
export function editJsonObject(file, mutate, { dryRun = false, secret = false } = {}) {
  const text = readIfExists(file);
  let data = {};
  if (text !== null) {
    let parsed;
    try {
      parsed = parseConfig(text);
    } catch {
      return { status: "manual", reason: "the file is not valid JSON" };
    }
    if (!parsed.strict) return { status: "manual", reason: "the file has comments, so it was left untouched" };
    if (!isRecord(parsed.data)) return { status: "manual", reason: "the file is not a JSON object" };
    data = parsed.data;
  }
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) return { status: "unchanged" };
  if (!dryRun) writeFileSafely(file, `${JSON.stringify(data, null, 2)}\n`, { secret });
  return { status: text === null ? "created" : "updated" };
}
