import path from "node:path";
import { KEY_ENV } from "../constants.js";
import { cleanChats } from "../lib/claude-chats.js";
import { exists } from "../lib/fsutil.js";
import { editJsonObject } from "../lib/json-config.js";
import { readState, stateFile, writeState } from "../lib/state.js";

// `use` / `unuse`: make OceanToken the model provider of a coding agent, and undo it.
// Unlike `connect`, which adds OceanToken's tools next to the agent's own models,
// this replaces the models the agent itself runs on. Codex's side is in codex-use.js.

export const CODEX_DEFAULT_MODEL = "openai/gpt-5.5";
export const CLAUDE_DEFAULT_MODELS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-latest",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-latest",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-latest",
};
// apiKeyHelper's output is sent as the key; Claude Code runs it in a shell.
const ENV_KEY_HELPER = `printenv ${KEY_ENV}`;

// Claude Code reads its settings when a session starts; an IDE keeps its session open until the window reloads.
const RESTART = "start a new Claude Code session (VS Code or Cursor: run Developer: Reload Window)";
// A chat open in Claude Code keeps its history in memory, so it is reopened from disk after unuse cleans it.
const RESTART_BACK =
  "VS Code or Cursor: run Developer: Reload Window, then reopen your chat from the past conversations; terminal: start claude again (claude --continue picks up the last chat)";

const claudeDir = (ctx) => ctx.env.CLAUDE_CONFIG_DIR || ctx.path(".claude");
const claudeSettings = (ctx) => `${claudeDir(ctx)}/settings.json`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

/** A new backup folder: <claude dir>/backups/oceantoken-cli-<UTC time>, never one that exists. */
function backupDir(ctx) {
  const base = path.join(claudeDir(ctx), "backups", `oceantoken-cli-${stamp()}`);
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    if (!exists(dir)) return dir;
  }
}

/**
 * Chats that ran on OceanToken carry a field Anthropic refuses (see claude-chats.js), so
 * a chat continued on the user's own plan would fail; take it out, backups first.
 */
function cleanClaudeChats(ctx) {
  const dir = ctx.dryRun ? null : backupDir(ctx);
  const found = cleanChats(claudeDir(ctx), { backupDir: dir });
  if (!found.length) {
    ctx.step("Chats", "ok", "nothing to clean");
    ctx.report.chats = "ready for your Claude plan";
    return;
  }
  const blocks = found.reduce((n, c) => n + c.blocks, 0);
  const chats = new Set(found.map((c) => c.chat)).size;
  const what = `${plural(chats, "chat")} (${plural(blocks, "tool call")} with a field your Claude plan refuses)`;
  if (ctx.dryRun) {
    ctx.step("Chats", "skipped", `would clean ${what}, backup first`);
    ctx.report.chats = `would clean ${what}`;
    return;
  }
  ctx.step("Chats", "ok", `cleaned ${what}; backup in ${dir}`);
  ctx.report.chats = `${plural(chats, "chat")} cleaned, so they continue on your Claude plan`;
  ctx.report.backup = [ctx.report.backup, dir].filter(Boolean).join("; ");
}

export function authText(ctx) {
  return ctx.useEnvKey ? `the ${KEY_ENV} environment variable` : "an API key saved in the config (owner-only file)";
}

/** The settings `use claude-code` writes: env entries, and apiKeyHelper in env-key mode. */
function claudeWanted(ctx) {
  const env = { ANTHROPIC_BASE_URL: ctx.apiBase };
  if (!ctx.useEnvKey) env.ANTHROPIC_AUTH_TOKEN = ctx.apiKey;
  if (ctx.model) {
    env.ANTHROPIC_MODEL = ctx.model;
    for (const k of Object.keys(CLAUDE_DEFAULT_MODELS)) env[k] = ctx.model;
  } else {
    Object.assign(env, CLAUDE_DEFAULT_MODELS);
  }
  return { env, apiKeyHelper: ctx.useEnvKey ? ENV_KEY_HELPER : undefined };
}

// Every setting `use` may touch, so a second `use` with other options also clears
// what the first one set (ANTHROPIC_MODEL after a --model run, the key helper).
const CLAUDE_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", ...Object.keys(CLAUDE_DEFAULT_MODELS)];

export async function claudeUse(ctx) {
  const file = claudeSettings(ctx);
  const wanted = claudeWanted(ctx);
  const state = readState(ctx.home);
  const saved = state["claude-code"]?.previous;
  const previous = saved ?? { env: {}, apiKeyHelper: null };

  const res = editJsonObject(
    file,
    (data) => {
      const env = data.env && typeof data.env === "object" && !Array.isArray(data.env) ? data.env : {};
      for (const key of CLAUDE_ENV_KEYS) {
        // Remember what the user had, once: a rerun must not save our own values.
        if (!saved) previous.env[key] = key in env ? env[key] : null;
        if (key in wanted.env) env[key] = wanted.env[key];
        else delete env[key];
      }
      // A key helper of the user's would compete with the token; it is restored on unuse.
      if (!saved) previous.apiKeyHelper = data.apiKeyHelper ?? null;
      if (wanted.apiKeyHelper) data.apiKeyHelper = wanted.apiKeyHelper;
      else delete data.apiKeyHelper;
      data.env = env;
    },
    { dryRun: ctx.dryRun, secret: true },
  );
  if (res.status === "manual") {
    ctx.step("Model provider", "manual", `${file}: ${res.reason}`);
    ctx.next(`Add these to "env" in ${file}:\n${JSON.stringify({ ...wanted.env, ANTHROPIC_AUTH_TOKEN: wanted.env.ANTHROPIC_AUTH_TOKEN ? "<your OceanToken API key>" : undefined }, null, 2)}`);
    return;
  }
  ctx.step("Model provider", "ok", `${file} (${ctx.dryRun ? `would be ${res.status}` : res.status})`);
  if (!ctx.dryRun && !saved) writeState(ctx.home, { ...state, "claude-code": { file, previous } });
  ctx.report.provider = `OceanToken (${ctx.apiBase}, Anthropic Messages API)`;
  ctx.report.model = ctx.model ?? "Opus / Sonnet / Haiku → the latest Claude models on OceanToken";
  ctx.report.authIn = authText(ctx);
  ctx.report.backup = `${file}.bak-oceantoken; previous values in ${stateFile(ctx.home)}`;
  ctx.report.restart = RESTART;
  ctx.next("Claude Code now bills your OceanToken balance instead of your Claude plan. Undo with `unuse claude-code`.");
  if (ctx.useEnvKey) ctx.next(`Claude Code reads the key from ${KEY_ENV} through apiKeyHelper: export it in your shell profile.`);
}

export async function claudeUnuse(ctx) {
  const file = claudeSettings(ctx);
  const state = readState(ctx.home);
  const saved = state["claude-code"]?.previous;
  // Also without an earlier `use`: chats from a gateway set up by hand fail the same way.
  cleanClaudeChats(ctx);
  ctx.report.restart = RESTART_BACK;
  if (!saved) {
    ctx.step("Model provider", "skipped", "nothing to undo (no earlier `use claude-code` on this machine)");
    return;
  }
  const res = editJsonObject(
    file,
    (data) => {
      const env = data.env && typeof data.env === "object" ? data.env : {};
      for (const [key, value] of Object.entries(saved.env)) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
      if (Object.keys(env).length) data.env = env;
      else delete data.env;
      if (saved.apiKeyHelper === null) delete data.apiKeyHelper;
      else data.apiKeyHelper = saved.apiKeyHelper;
    },
    { dryRun: ctx.dryRun, secret: true },
  );
  if (res.status === "manual") {
    ctx.step("Model provider", "manual", `${file}: ${res.reason}`);
    ctx.next(`Remove the ANTHROPIC_* entries this CLI added from "env" in ${file}.`);
    return;
  }
  ctx.step("Model provider", "ok", `${file} (${ctx.dryRun ? "would be restored" : "restored"})`);
  if (!ctx.dryRun) {
    const { "claude-code": _gone, ...rest } = state;
    writeState(ctx.home, rest);
  }
}
