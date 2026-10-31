import { readState, stateFile, writeState } from "./state.js";

// The key `use` was given, kept per agent in the CLI's owner-only state file, so switching
// back to OceanToken after `unuse` needs no key pasted (board 2026-10-30: people switch
// between their own plan and OceanToken often). `unuse --forget-key` removes it, and a
// kept key OceanToken rejects is dropped so the next `use` asks for a new one.

export const keptKeyFile = stateFile;

export function keptKey(home, id) {
  const key = readState(home).keys?.[id];
  return typeof key === "string" && key ? key : null;
}

export function keepKey(home, id, key) {
  const state = readState(home);
  if (state.keys?.[id] === key) return;
  writeState(home, { ...state, keys: { ...(state.keys ?? {}), [id]: key } });
}

/** Whether there was a key to forget. */
export function forgetKey(home, id) {
  const state = readState(home);
  if (!state.keys?.[id]) return false;
  const { [id]: _gone, ...rest } = state.keys;
  const { keys: _all, ...others } = state;
  writeState(home, Object.keys(rest).length ? { ...others, keys: rest } : others);
  return true;
}
