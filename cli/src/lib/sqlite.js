import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// Codex keeps its chat list in a SQLite file. The CLI has no dependencies, so it uses
// node:sqlite when this Node has it (22.13 and later), and otherwise the `sqlite3`
// command (shipped with macOS). Values only ever come from that same database or from
// this CLI, and are still quoted as SQL literals.

const require = createRequire(import.meta.url);

function loadNodeSqlite() {
  const emit = process.emitWarning;
  // node:sqlite announces itself as experimental on stderr; that line would only confuse.
  process.emitWarning = (warning, ...rest) => {
    if (String(warning?.message ?? warning).includes("SQLite")) return;
    emit.call(process, warning, ...rest);
  };
  try {
    return require("node:sqlite");
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

/** A SQL literal: NULL, a number, or a single-quoted string. */
export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function fromNode(sqlite, file, readOnly) {
  const db = new sqlite.DatabaseSync(file, readOnly ? { readOnly: true } : {});
  db.exec("PRAGMA busy_timeout = 5000");
  return {
    kind: "node:sqlite",
    all: (sql) => db.prepare(sql).all().map((row) => ({ ...row })),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

/** The `sqlite3` command as a database (also used directly by the tests). */
export function fromCommand(binary, file, readOnly = false) {
  const run = (sql, args = []) => {
    const res = spawnSync(binary, [...args, ...(readOnly ? ["-readonly"] : []), "-bail", file], { input: `.timeout 5000\n${sql}\n`, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`sqlite3: ${(res.stderr || res.error?.message || "failed").trim()}`);
    return res.stdout;
  };
  return {
    kind: "sqlite3",
    all: (sql) => {
      const out = run(sql, ["-json"]).trim();
      return out ? JSON.parse(out) : [];
    },
    exec: (sql) => void run(sql),
    close: () => {},
  };
}

/**
 * Open a SQLite database file, or return null when this machine has no way to:
 * `{ kind, all(sql) -> rows, exec(sql), close() }`.
 */
export function openDatabase(file, { which, readOnly = false } = {}) {
  const sqlite = loadNodeSqlite();
  if (sqlite?.DatabaseSync) return fromNode(sqlite, file, readOnly);
  const binary = which?.("sqlite3");
  return binary ? fromCommand(binary, file, readOnly) : null;
}
