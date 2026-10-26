import fs from "node:fs";
import path from "node:path";
import { KEY_ENV, PLUGIN_ID, SERVER_NAME, SKILL_NAMES } from "../constants.js";
import { codexBlock, hasCodexBlock, removeBlock, removeMarkdownNote, upsertCodexBlock, upsertMarkdownNote } from "../lib/blocks.js";
import { listModels } from "../lib/apikey.js";
import { CATALOG_FILE, bundledCatalog, oceanTokenCatalog } from "../lib/codex-catalog.js";
import { OCEANTOKEN, OPENAI, runningCodex } from "../lib/codex-chats.js";
import { exists, readIfExists } from "../lib/fsutil.js";
import { applyCodexProvider, revertCodexProvider } from "../lib/provider.js";
import { OWNER_FILE } from "../lib/skills.js";
import { readState, writeState } from "../lib/state.js";
import { codexHome, countChats, moveChatsToOceanToken, moveChatsToOpenAI } from "./codex-move.js";
import { CODEX_DEFAULT_MODEL, authText } from "./provider-switch.js";

// `use codex` makes OceanToken the model provider in config.toml (lib/provider.js) and,
// unless --no-tools, also connects OceanToken's own tools: Codex on OceanToken has no
// built-in image tool (that comes with a ChatGPT plan), so without them an image request
// ends up nowhere, or at a third-party app. What `use` added is recorded in
// ~/.oceantoken/cli-state.json, so `unuse` removes exactly that and keeps what
// `connect codex` or the user set up.

const configFile = (ctx) => path.join(codexHome(ctx), "config.toml");
const skillsDir = (ctx) => ctx.path(".agents", "skills");
const NATIVE_PLUGIN = /^\s*\[plugins\."oceantoken@oceantoken"\]/m;

/** The note `use` adds to Codex's global instructions. */
export const MEDIA_NOTE = `## Images, video and audio: use OceanToken

Codex runs on OceanToken here. For images, video, speech and transcription, use the OceanToken tools (MCP server \`${SERVER_NAME}\`: generate_image, create_video, get_job, generate_speech, transcribe_audio) and follow the oceantoken-media skill. Do not use the built-in image_gen tool or the imagegen skill (they need a ChatGPT plan this setup does not use), and do not send media generation to other apps or connectors unless the user names one.`;

/**
 * Where the note goes: Codex reads CODEX_HOME/AGENTS.override.md instead of AGENTS.md when
 * the override has content. The desktop app replaces config.toml's developer_instructions
 * with its own, so the note lives in this file, which every Codex reads.
 */
function instructionsFile(ctx) {
  const override = path.join(codexHome(ctx), "AGENTS.override.md");
  return readIfExists(override)?.trim() ? override : path.join(codexHome(ctx), "AGENTS.md");
}

function savedTools(state) {
  const t = state.codex?.tools ?? {};
  return { mcp: t.mcp ?? null, skills: [...(t.skills ?? [])], note: t.note ?? null, noteCreated: Boolean(t.noteCreated) };
}

/** MCP server + skills + the instructions note. Returns what was added (for the state file). */
function connectTools(ctx, tools) {
  const file = configFile(ctx);
  const text = readIfExists(file) ?? "";
  if (NATIVE_PLUGIN.test(text)) {
    ctx.step("Tools", "ok", `already connected through the ${PLUGIN_ID} plugin`);
    ctx.report.mcp = `${SERVER_NAME} via plugin ${PLUGIN_ID}`;
  } else if (!ctx.mcpUrl) {
    ctx.step("Tools", "manual", `no OceanToken tools server goes with ${ctx.apiBase}; pass --url <mcp-url>`);
  } else {
    const had = hasCodexBlock(text);
    const block = ctx.useEnvKey
      ? codexBlock(ctx.mcpUrl, undefined, { bearerEnv: KEY_ENV })
      : codexBlock(ctx.mcpUrl, { Authorization: `Bearer ${ctx.apiKey}` });
    if (ctx.editText("MCP server", file, (t) => upsertCodexBlock(t, block))) {
      if (!had) tools.mcp = "added";
      ctx.report.mcp = `${SERVER_NAME} in ${file}`;
    } else {
      ctx.next(`Your own [mcp_servers.${SERVER_NAME}] table in ${file} was left as it is.`);
    }
    const dir = skillsDir(ctx);
    const before = new Set(SKILL_NAMES.filter((n) => exists(path.join(dir, n))));
    ctx.installSkillsTo(dir);
    if (ctx.skills) {
      for (const n of SKILL_NAMES) {
        const ours = ctx.dryRun || exists(path.join(dir, n, OWNER_FILE));
        if (!before.has(n) && ours && !tools.skills.includes(n)) tools.skills.push(n);
      }
    }
  }
  const note = instructionsFile(ctx);
  const existed = readIfExists(note) !== null;
  if (ctx.editText("Instructions", note, (t) => upsertMarkdownNote(t, MEDIA_NOTE))) {
    if (!existed && !tools.note) tools.noteCreated = true;
    tools.note = note;
    ctx.report.instructions = `${note} (images, video and audio go through OceanToken)`;
  }
  return tools;
}

/** removeBlock, ending the file with one newline as before the block was appended. */
function removeMcpBlock(text) {
  const res = removeBlock(text);
  return res.status === "removed" ? { ...res, text: `${res.text.replace(/\s*$/, "")}\n` } : res;
}

function removeTools(ctx, tools) {
  if (tools.mcp === "added") ctx.editText("MCP server", configFile(ctx), removeMcpBlock);
  if (tools.skills.length) ctx.removeSkillsFrom(skillsDir(ctx), tools.skills);
  const files = new Set([tools.note, instructionsFile(ctx), path.join(codexHome(ctx), "AGENTS.md")].filter(Boolean));
  for (const f of files) {
    if (!readIfExists(f)?.includes("<!-- end OceanToken -->")) continue;
    ctx.editText("Instructions", f, removeMarkdownNote);
    if (!ctx.dryRun && tools.noteCreated && f === tools.note && readIfExists(f) === "") fs.rmSync(f, { force: true });
  }
}

/** Codex must not be writing its chats while they move: check before changing anything. */
async function codexIsRunning(ctx) {
  const running = await runningCodex(ctx.probe);
  if (running === null) {
    ctx.step("Chats", "failed", "could not check whether Codex is running; nothing changed");
    return true;
  }
  if (!running.length) return false;
  ctx.step("Chats", "failed", `Codex is running (${[...new Set(running.map((p) => path.basename(p)))].join(", ")}); nothing changed`);
  ctx.next("Quit the ChatGPT app (Cmd+Q) and close every Codex window or terminal, then run this again. Chats cannot move while Codex has them open.");
  return true;
}

/**
 * Without --move-chats: say what happens to the existing chats, and on a terminal offer
 * to move them (default no).
 */
async function offerMove(ctx, provider, question, nextLine, move) {
  if (ctx.dryRun) return;
  const n = countChats(ctx, provider);
  if (!n) return;
  if (ctx.confirm && (await ctx.confirm(question(n)))) {
    await move();
    return;
  }
  ctx.next(nextLine(n));
}

/**
 * Write the model list Codex's picker shows (lib/codex-catalog.js) and return its path, or
 * null when Codex's own list could not be read (the picker then keeps ChatGPT's names).
 */
async function writeModelList(ctx, available) {
  const bundled = await bundledCatalog(ctx);
  const catalog = bundled && oceanTokenCatalog(bundled.models, available);
  const file = path.join(codexHome(ctx), CATALOG_FILE);
  if (!catalog) {
    ctx.step("Model list", "skipped", bundled ? "OceanToken offers none of this Codex's models" : "Codex's own model list could not be read");
    return null;
  }
  const shown = catalog.models.filter((m) => m.visibility === "list").map((m) => m.slug);
  if (!ctx.dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(catalog, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }
  ctx.step("Model list", "ok", `${file} (${ctx.dryRun ? "would list" : "lists"} ${shown.length}: ${shown.slice(0, 3).join(", ")}${shown.length > 3 ? ", ..." : ""})`);
  return file;
}

export async function codexUse(ctx, { fetchImpl } = {}) {
  if (ctx.moveChats && !ctx.dryRun && (await codexIsRunning(ctx))) return;
  const file = configFile(ctx);
  const model = ctx.model ?? CODEX_DEFAULT_MODEL;
  const auth = ctx.useEnvKey ? { envKey: KEY_ENV } : { headers: { Authorization: `Bearer ${ctx.apiKey}` } };
  const key = ctx.apiKey ?? ctx.env[KEY_ENV];
  const available = key ? await listModels(key, { apiBase: ctx.apiBase, fetchImpl }) : null;
  const catalog = await writeModelList(ctx, available);
  const ok = ctx.editText("Model provider", file, (text) =>
    applyCodexProvider(text, { baseUrl: `${ctx.apiBase}/v1`, model, auth, catalog }),
  );
  if (!ok) {
    if (catalog && !ctx.dryRun) fs.rmSync(catalog, { force: true });
    ctx.next(`Rename or remove your own [model_providers.oceantoken] table in ${file}, then run this again.`);
    return;
  }
  const before = readState(ctx.home);
  if (!ctx.dryRun) {
    // A list an earlier run wrote that config.toml no longer names is removed.
    const old = before.codex?.catalog;
    if (old && old !== catalog) fs.rmSync(old, { force: true });
    writeState(ctx.home, { ...before, codex: { ...(before.codex ?? {}), catalog: catalog ?? undefined } });
  }
  ctx.report.provider = `OceanToken (${ctx.apiBase}/v1, Responses API)`;
  ctx.report.model = model;
  ctx.report.authIn = authText(ctx);
  ctx.report.backup = readIfExists(`${file}.bak-oceantoken`) !== null ? `${file}.bak-oceantoken` : "none (new file)";
  ctx.report.restart = "quit and reopen the ChatGPT app, or start a new Codex session";
  if (ctx.useEnvKey) ctx.next(`Codex reads the key from ${KEY_ENV}: export it in your shell profile.`);
  if (!model.startsWith("openai/")) {
    ctx.next(`Codex has no built-in profile for ${model}; it falls back to defaults and prints a warning. Tools still work.`);
  }

  const state = readState(ctx.home);
  if (catalog) ctx.report.model = `${model}; the model picker lists OceanToken's ids`;
  if (ctx.tools) {
    const tools = connectTools(ctx, savedTools(state));
    if (!ctx.dryRun) writeState(ctx.home, { ...state, codex: { ...(state.codex ?? {}), tools } });
  } else {
    ctx.step("Tools", "skipped", "--no-tools");
  }

  if (ctx.moveChats) {
    await moveChatsToOceanToken(ctx, { fetchImpl });
    return;
  }
  await offerMove(
    ctx,
    OPENAI,
    (n) =>
      `\nYou have ${n} chats from your ChatGPT plan. Codex keeps each chat on the provider it started on, ` +
      "so they still use your plan and its limits.\nMove them to OceanToken too? Codex must be quit first; " +
      "a backup is made, and `unuse codex --move-chats` moves them back.",
    (n) =>
      `Your ${n} existing chats stay on your ChatGPT plan (new chats use OceanToken). To move them too, ` +
      "quit Codex and run `use codex --move-chats`.",
    () => moveChatsToOceanToken(ctx, { fetchImpl }),
  );
}

export async function codexUnuse(ctx) {
  if (ctx.moveChats && !ctx.dryRun && (await codexIsRunning(ctx))) return;
  // Chats first: once the provider table is gone, Codex cannot open an OceanToken chat,
  // so a move that fails stops here with nothing else changed.
  if (ctx.moveChats) {
    await moveChatsToOpenAI(ctx);
    if (ctx.report.steps.some((s) => s.status === "failed")) return;
  }

  ctx.editText("Model provider", configFile(ctx), revertCodexProvider);
  const state = readState(ctx.home);
  removeTools(ctx, savedTools(state));
  // Only after config.toml stops naming it: Codex will not start with a missing list.
  const catalog = state.codex?.catalog;
  if (catalog && exists(catalog)) {
    if (!ctx.dryRun) fs.rmSync(catalog, { force: true });
    ctx.step("Model list", "ok", `${catalog} (${ctx.dryRun ? "would be removed" : "removed"})`);
  }
  if (!ctx.dryRun && (state.codex?.tools || catalog)) {
    const { tools: _gone, catalog: _list, ...rest } = state.codex;
    writeState(ctx.home, { ...state, codex: rest });
  }
  ctx.report.restart = "quit and reopen the ChatGPT app, or start a new Codex session";

  if (!ctx.moveChats) {
    await offerMove(
      ctx,
      OCEANTOKEN,
      (n) =>
        `\n${n} chats are on OceanToken. Without OceanToken set up, Codex cannot open them.\n` +
        "Move them to your ChatGPT plan? Codex must be quit first; a backup is made.",
      (n) =>
        `${n} chats are on OceanToken and will not open without it. Quit Codex and run ` +
        "`unuse codex --move-chats` to move them to your ChatGPT plan, or `use codex` to keep using them.",
      () => moveChatsToOpenAI(ctx),
    );
  }
}
