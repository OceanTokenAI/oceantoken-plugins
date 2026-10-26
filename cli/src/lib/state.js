import fs from "node:fs";
import path from "node:path";
import { readIfExists } from "./fsutil.js";

// What `use` replaced, so `unuse` can put it back: per client, the previous value of
// every setting it changed (null when the setting was absent). The file can hold a
// key the user had before, so it is owner-only.

export const stateFile = (home) => path.join(home, ".oceantoken", "cli-state.json");

export function readState(home) {
  try {
    return JSON.parse(readIfExists(stateFile(home)) ?? "{}");
  } catch {
    return {};
  }
}

export function writeState(home, state) {
  const file = stateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
