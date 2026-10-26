import fs from "node:fs";
import path from "node:path";
import { KEY_ENV } from "../constants.js";
import { listModels } from "../lib/apikey.js";
import {
  OCEANTOKEN,
  OPENAI,
  backupDatabase,
  blankOceanTokenReasoning,
  planToOceanToken,
  planToOpenAI,
  readRollout,
  repoint,
  rolloutChain,
  rolloutIndex,
  runningCodex,
  stateDbFile,
  threadsOn,
  writeRollout,
} from "../lib/codex-chats.js";
import { which as realWhich } from "../lib/run.js";
import { openDatabase } from "../lib/sqlite.js";
import { readState, writeState } from "../lib/state.js";

// `--move-chats`: the chats Codex already has follow the provider. See lib/codex-chats.js
// for what is changed and why. Every change is backed up first, and nothing is changed
// while Codex could be writing the same files.

export const codexHome = (ctx) => ctx.env.CODEX_HOME || ctx.path(".codex");

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describeKept(keep) {
  const models = [...new Set(keep.map((k) => k.model))].slice(0, 4).join(", ");
  return `${plural(keep.length, "chat")} on ${models}`;
}

/** Open Codex's chat database for a move, or record why not. Returns { db, file } or null. */
async function openForMove(ctx, home) {
  const file = stateDbFile(home);
  if (!file) {
    ctx.step("Chats", "skipped", `no Codex chats in ${home}`);
    return null;
  }
  const running = await runningCodex(ctx.probe);
  if (running === null) {
    ctx.step("Chats", "failed", "could not check whether Codex is running; nothing moved");
    return null;
  }
  if (running.length) {
    const what = [...new Set(running.map((p) => path.basename(p)))].join(", ");
    ctx.step("Chats", ctx.dryRun ? "manual" : "failed", `Codex is running (${what}); ${ctx.dryRun ? "it must be quit before chats can move" : "nothing moved"}`);
    ctx.next("Quit the ChatGPT app (Cmd+Q) and close every Codex window or terminal, then run this again. Chats cannot move while Codex has them open.");
    return null;
  }
  const db = openDatabase(file, { which: (cmd) => realWhich(cmd, ctx.env) });
  if (!db) {
    ctx.step("Chats", "failed", "reading Codex's chat list needs Node 22.13 or later, or the sqlite3 command");
    return null;
  }
  return { db, file };
}

/** A new backup folder: backups/oceantoken-cli-<UTC time>, never one that exists. */
function backupDir(home) {
  const base = path.join(home, "backups", `oceantoken-cli-${stamp()}`);
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    if (!fs.existsSync(dir)) return dir;
  }
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

/** ChatGPT-plan chats -> OceanToken. Only Codex's chat list changes, never a chat file. */
export async function moveChatsToOceanToken(ctx, { fetchImpl } = {}) {
  const home = codexHome(ctx);
  const opened = await openForMove(ctx, home);
  if (!opened) return;
  const { db, file } = opened;
  try {
    const rows = threadsOn(db, OPENAI);
    const key = ctx.apiKey ?? ctx.env[KEY_ENV];
    const available = key ? await listModels(key, { apiBase: ctx.apiBase, fetchImpl }) : null;
    const plan = planToOceanToken(rows, available);
    if (plan.keep.length) {
      ctx.next(`${describeKept(plan.keep)} stay on your ChatGPT plan: OceanToken does not offer that model.`);
    }
    if (!plan.move.length) {
      ctx.step("Chats", "skipped", "no ChatGPT-plan chats to move");
      ctx.report.chats = "none to move";
      return;
    }
    if (ctx.dryRun) {
      ctx.step("Chats", "skipped", `would move ${plural(plan.move.length, "chat")} to OceanToken (backup first)`);
      ctx.report.chats = `${plan.move.length} would move`;
      return;
    }
    const dir = backupDir(home);
    backupDatabase(db, path.join(dir, path.basename(file)));
    writeManifest(dir, { direction: "to-oceantoken", at: new Date().toISOString(), database: file, moved: plan.move });
    repoint(db, plan.move, OPENAI, OCEANTOKEN);

    const state = readState(ctx.home);
    const at = new Date().toISOString();
    const moved = { ...(state.codex?.moved ?? {}) };
    for (const m of plan.move) if (!moved[m.id]) moved[m.id] = { model: m.model ?? null, at };
    writeState(ctx.home, { ...state, codex: { ...(state.codex ?? {}), moved } });

    ctx.step("Chats", "ok", `${plural(plan.move.length, "chat")} now on OceanToken; backup in ${dir}`);
    ctx.report.chats = `${plan.move.length} moved to OceanToken`;
    ctx.report.backup = [ctx.report.backup, dir].filter(Boolean).join("; ");
    ctx.next(`Your existing chats now bill your OceanToken balance. \`unuse codex --move-chats\` moves them back.`);
  } finally {
    db.close();
  }
}

/**
 * OceanToken chats -> the ChatGPT plan. Reasoning made through OceanToken is blanked in the
 * chat files first (a ChatGPT plan rejects it); chats on models a ChatGPT plan does not run
 * stay on OceanToken.
 */
export async function moveChatsToOpenAI(ctx) {
  const home = codexHome(ctx);
  const opened = await openForMove(ctx, home);
  if (!opened) return { left: null };
  const { db, file } = opened;
  try {
    const state = readState(ctx.home);
    const rows = threadsOn(db, OCEANTOKEN);
    const plan = planToOpenAI(rows, state.codex?.moved);
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (!plan.move.length) {
      ctx.step("Chats", "skipped", "no OceanToken chats to move back");
      ctx.report.chats = "none to move";
      return { left: plan.keep.length };
    }

    // Blank OceanToken's reasoning in every file of every chat that moves.
    const index = rolloutIndex(home);
    const content = new Map();
    const read = (f) => {
      if (!content.has(f)) content.set(f, readRollout(f));
      return content.get(f);
    };
    const changed = new Set();
    const stuck = [];
    let blanked = 0;
    for (const m of plan.move) {
      // Per chat, so a chat that cannot be cleaned leaves no half-edited file behind.
      const edits = new Map();
      let count = 0;
      try {
        // A chat without its file has nothing to blank; only its list entry moves.
        const chain = rolloutChain(index, byId.get(m.id).rollout_path, read);
        let turnModel = null;
        for (const f of chain) {
          const res = blankOceanTokenReasoning(edits.get(f) ?? read(f), turnModel);
          turnModel = res.turnModel;
          if (res.unsafe) throw new Error(`${path.basename(f)} has reasoning this CLI cannot blank safely`);
          if (res.blanked) {
            edits.set(f, res.content);
            count += res.blanked;
          }
        }
      } catch (err) {
        stuck.push({ id: m.id, reason: err.message });
        continue;
      }
      for (const [f, c] of edits) {
        content.set(f, c);
        changed.add(f);
      }
      blanked += count;
    }
    const moving = plan.move.filter((m) => !stuck.some((s) => s.id === m.id));
    for (const s of stuck) ctx.next(`Chat ${s.id} stays on OceanToken: ${s.reason}.`);
    if (plan.keep.length) {
      ctx.next(`${describeKept(plan.keep)} stay on OceanToken: a ChatGPT plan does not run those models. They open again after \`use codex\`.`);
    }
    const files = [...changed];
    if (!moving.length) {
      ctx.step("Chats", "manual", "no OceanToken chat could move back; nothing changed");
      ctx.report.chats = "none moved";
      return { left: plan.keep.length + stuck.length };
    }
    if (ctx.dryRun) {
      ctx.step("Chats", "skipped", `would move ${plural(moving.length, "chat")} back to ChatGPT, blanking ${plural(blanked, "hidden reasoning item")} made on OceanToken (backup first)`);
      ctx.report.chats = `${moving.length} would move back`;
      return { left: plan.keep.length + stuck.length };
    }

    const dir = backupDir(home);
    backupDatabase(db, path.join(dir, path.basename(file)));
    for (const f of files) {
      const copy = path.join(dir, "chats", path.relative(home, f));
      fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
      fs.copyFileSync(f, copy, fs.constants.COPYFILE_EXCL);
    }
    writeManifest(dir, { direction: "to-openai", at: new Date().toISOString(), database: file, moved: moving, files });
    for (const f of files) writeRollout(f, content.get(f));
    repoint(db, moving, OCEANTOKEN, OPENAI);

    const moved = { ...(state.codex?.moved ?? {}) };
    for (const m of moving) delete moved[m.id];
    writeState(ctx.home, { ...state, codex: { ...(state.codex ?? {}), moved } });

    ctx.step("Chats", "ok", `${plural(moving.length, "chat")} back on your ChatGPT plan (${plural(blanked, "hidden reasoning item")} made on OceanToken blanked); backup in ${dir}`);
    ctx.report.chats = `${moving.length} moved back to ChatGPT`;
    ctx.report.backup = [ctx.report.backup, dir].filter(Boolean).join("; ");
    return { left: plan.keep.length + stuck.length };
  } finally {
    db.close();
  }
}

/** How many chats sit on `provider`, without changing anything (null when unknown). */
export function countChats(ctx, provider) {
  const file = stateDbFile(codexHome(ctx));
  if (!file) return 0;
  const db = openDatabase(file, { which: (cmd) => realWhich(cmd, ctx.env), readOnly: true });
  if (!db) return null;
  try {
    return threadsOn(db, provider).length;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
