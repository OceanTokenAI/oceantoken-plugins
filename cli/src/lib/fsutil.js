import fs from "node:fs";
import path from "node:path";

export function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

const BACKUP_SUFFIX = ".bak-oceantoken";

/** 2026-10-04T08:15:30.123Z -> 20261004T081530Z */
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

/**
 * Copy a file before this CLI rewrites it. The first copy, `<file>.bak-oceantoken`, is the
 * file as it was before the CLI ever changed it and is never overwritten; every later
 * rewrite leaves `<file>.bak-oceantoken-<UTC time>` with the file as it was just before.
 * A backup may hold a key, so it is owner-only. Returns the backup's path.
 */
export function backupFile(file, { now = new Date() } = {}) {
  let target = `${file}${BACKUP_SUFFIX}`;
  for (let n = 1; ; n++) {
    try {
      // EXCL: an existing backup is never replaced, not even by a second write in the same second.
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, fs.statSync(target).mode & 0o700);
      return target;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    target = `${file}${BACKUP_SUFFIX}-${stamp(now)}${n > 1 ? `-${n}` : ""}`;
  }
}

/**
 * Write a file through a temp file and rename, so a crash never leaves half a config.
 * An existing file keeps its permissions and is backed up first (see backupFile); a file
 * that may hold a key is made owner-only, new or not.
 */
export function writeFileSafely(file, text, { secret = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = secret ? 0o600 : 0o644;
  if (exists(file)) {
    mode = fs.statSync(file).mode & (secret ? 0o700 : 0o777);
    backupFile(file);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

export function copyDir(src, dst, { skip = [] } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to, { skip });
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
