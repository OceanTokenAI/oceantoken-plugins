import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import {
  DROPPED_TYPE,
  blankOceanTokenReasoning,
  planToOceanToken,
  planToOpenAI,
  rolloutChain,
  rolloutIndex,
  runningCodex,
} from "../src/lib/codex-chats.js";
import { which } from "../src/lib/run.js";
import { fromCommand, openDatabase, sqlValue } from "../src/lib/sqlite.js";
import { KEY, cli as runCli, exists, read, readJson, tempHome } from "./helpers.js";

// The chat list is read with node:sqlite or the real sqlite3 command, found on the real PATH.
const cli = (argv, opts = {}) => runCli(argv, { ...opts, env: { PATH: process.env.PATH, ...(opts.env ?? {}) } });

// --move-chats: Codex reopens a chat with the provider and model stored for it in
// state_<n>.sqlite, so that is what moves; moving back also blanks the hidden reasoning
// OceanToken produced, which a ChatGPT plan cannot read.

const sqliteFor = (file) => openDatabase(file, { which: (c) => which(c) });
const probe = sqliteFor(path.join(tempHome(), "probe.sqlite"));
const NO_SQLITE = probe ? false : "needs node:sqlite (Node 22.13+) or the sqlite3 command";
probe?.close();

const NOT_RUNNING = (cmd) => (cmd === "ps" ? { code: 0, stdout: "  101 /usr/sbin/cron\n  202 /bin/zsh\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
const APP_RUNNING = (cmd) =>
  cmd === "ps"
    ? { code: 0, stdout: "  101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n  102 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex\n", stderr: "" }
    : { code: 0, stdout: "", stderr: "" };

const line = (obj) => JSON.stringify(obj);
const meta = (id, provider, historyBase) =>
  line({ timestamp: "2026-10-18T10:00:00.000Z", ordinal: 0, type: "session_meta", payload: { id, model_provider: provider, ...(historyBase ? { history_base: historyBase } : {}) } });
const turn = (ordinal, model) => line({ timestamp: "2026-10-18T10:00:01.000Z", ordinal, type: "turn_context", payload: { model, turn_id: `t${ordinal}` } });
const say = (ordinal, role, text) =>
  line({ timestamp: "2026-10-18T10:00:02.000Z", ordinal, type: "response_item", payload: { type: "message", role, content: [{ type: "output_text", text }] } });
const thought = (ordinal, tag) =>
  line({ timestamp: "2026-10-18T10:00:03.000Z", ordinal, type: "response_item", payload: { type: "reasoning", id: `rs_${tag}`, summary: [], encrypted_content: `gAAAAB-${tag}-${"x".repeat(200)}` } });

/** A chat with one ChatGPT turn and one OceanToken turn. */
const MIXED = [
  meta("t-mixed", "oceantoken"),
  turn(1, "gpt-6-astra"),
  say(2, "user", "first question"),
  thought(3, "chatgpt"),
  say(4, "assistant", "first answer"),
  turn(5, "openai/gpt-6-astra"),
  say(6, "user", "second question, café"),
  thought(7, "oceantoken"),
  say(8, "assistant", "second answer"),
].join("\n") + "\n";

test("plans: ChatGPT chats move under OceanToken's model name; models it does not sell stay", () => {
  const rows = [
    { id: "a", model: "gpt-6-astra" },
    { id: "b", model: "codex-auto-review" },
    { id: "c", model: null },
    { id: "d", model: "gpt-5.6-terra" },
  ];
  const listed = planToOceanToken(rows, new Set(["openai/gpt-6-astra", "openai/gpt-5.6-terra"]));
  assert.deepEqual(listed.move.map((m) => [m.id, m.to]), [["a", "openai/gpt-6-astra"], ["c", null], ["d", "openai/gpt-5.6-terra"]]);
  assert.deepEqual(listed.keep.map((k) => k.id), ["b"]);
  // Without the model list, only gpt-* models move.
  assert.deepEqual(planToOceanToken(rows, null).keep.map((k) => k.id), ["b"]);

  const back = planToOpenAI(
    [{ id: "a", model: "openai/gpt-6-astra" }, { id: "e", model: "openai/gpt-5.5" }, { id: "f", model: "deepseek/deepseek-v4-pro" }, { id: "g", model: "openai/gpt-6-astra" }],
    { g: { model: "gpt-6-astra-2026-09-03" } },
  );
  assert.deepEqual(back.move.map((m) => [m.id, m.to]), [["a", "gpt-6-astra"], ["e", "gpt-5.5"], ["g", "gpt-6-astra-2026-09-03"]]);
  assert.deepEqual(back.keep.map((k) => k.id), ["f"]);
});

test("blanking keeps every line's byte length, drops only reasoning made in OceanToken turns", () => {
  const before = Buffer.from(MIXED);
  const res = blankOceanTokenReasoning(before);
  assert.equal(res.blanked, 1);
  assert.equal(res.content.length, before.length, "file length unchanged");
  const a = before.toString().split("\n");
  const b = res.content.toString().split("\n");
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.equal(Buffer.byteLength(a[i]), Buffer.byteLength(b[i]), `line ${i} keeps its length`);
  const lines = b.filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[3].payload.encrypted_content.startsWith("gAAAAB-chatgpt"), true, "ChatGPT's own reasoning stays");
  assert.deepEqual(lines[7], { timestamp: "2026-10-18T10:00:03.000Z", ordinal: 7, type: "response_item", payload: { type: DROPPED_TYPE, id: "rs_oceantoken" } });
  assert.equal(lines[6].payload.content[0].text, "second question, café", "the conversation is untouched");
  assert.equal(res.turnModel, "openai/gpt-6-astra");
  // A second pass finds nothing left.
  assert.equal(blankOceanTokenReasoning(res.content).blanked, 0);
});

test("blanking reaches into a compacted history, and refuses a line it cannot rewrite exactly", () => {
  const compacted = line({
    timestamp: "t",
    ordinal: 3,
    type: "compacted",
    payload: { message: "summary", replacement_history: [{ type: "message", role: "user", content: [] }, { type: "reasoning", id: "rs_1", encrypted_content: "gAAAA".repeat(40) }] },
  });
  const text = Buffer.from(`${turn(1, "openai/gpt-5.5")}\n${compacted}\n`);
  const res = blankOceanTokenReasoning(text);
  assert.equal(res.blanked, 1);
  assert.equal(res.content.length, text.length);
  assert.equal(JSON.parse(res.content.toString().split("\n")[1]).payload.replacement_history[1].type, DROPPED_TYPE);

  // 1.0 would come back as 1: such a line is reported, not rewritten.
  const odd = compacted.replace('"ordinal":3', '"ordinal":3.0');
  const unsafe = blankOceanTokenReasoning(Buffer.from(`${turn(1, "openai/gpt-5.5")}\n${odd}\n`));
  assert.equal(unsafe.unsafe, 1);
  assert.equal(unsafe.blanked, 0);
});

test("a segmented chat is followed back through history_base to its first file", () => {
  const home = tempHome();
  const dir = path.join(home, ".codex", "sessions", "2026", "10", "18");
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, "rollout-2026-10-18T10-00-00-11111111-1111-1111-1111-111111111111.jsonl");
  const seg = path.join(dir, "rollout-2026-10-18T11-00-00-11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222.jsonl");
  fs.writeFileSync(base, `${meta("11111111-1111-1111-1111-111111111111", "openai")}\n`);
  fs.writeFileSync(seg, `${meta("11111111-1111-1111-1111-111111111111", "openai", { thread_id: "11111111-1111-1111-1111-111111111111", end_ordinal_exclusive: 1, end_byte_offset: 10 })}\n`);
  const index = rolloutIndex(path.join(home, ".codex"));
  assert.deepEqual(rolloutChain(index, seg, (f) => fs.readFileSync(f)), [base, seg]);
});

test("the running check sees the ChatGPT app and any codex process, on macOS, Linux and Windows", async () => {
  const ps = (stdout) => async () => ({ code: 0, stdout });
  assert.deepEqual(await runningCodex(ps("  1 /sbin/launchd\n 2 /bin/zsh\n"), "darwin"), []);
  assert.equal((await runningCodex(ps(APP_RUNNING("ps").stdout), "darwin")).length, 2);
  assert.deepEqual(await runningCodex(ps("  9 codex\n"), "linux"), ["codex"]);
  assert.deepEqual(await runningCodex(ps("  9 /Users/me/.codex/plugins/cache/x/ChatGPT for Chrome\n"), "darwin"), [], "a browser helper is not Codex");
  assert.deepEqual(await runningCodex(async () => ({ code: 0, stdout: '"ChatGPT.exe","4","Console"\r\n"explorer.exe","5"\r\n' }), "win32"), ["chatgpt.exe"]);
  assert.equal(await runningCodex(async () => ({ code: 1, stdout: "" }), "darwin"), null);
});

// -- end to end through the CLI, on a Codex home with a real chat database -----------------

function codexHomeWithChats(home, threads, files = {}) {
  const codex = path.join(home, ".codex");
  fs.mkdirSync(codex, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(codex, rel)), { recursive: true });
    fs.writeFileSync(path.join(codex, rel), text);
  }
  const db = sqliteFor(path.join(codex, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, model TEXT, title TEXT NOT NULL DEFAULT '');");
  for (const t of threads) {
    const p = t.file ? path.join(codex, t.file) : `${codex}/sessions/none-${t.id}.jsonl`;
    db.exec(`INSERT INTO threads (id, rollout_path, model_provider, model) VALUES ('${t.id}', '${p}', '${t.provider}', ${t.model === null ? "NULL" : `'${t.model}'`});`);
  }
  db.close();
  return codex;
}

function threadsIn(codex) {
  const db = sqliteFor(path.join(codex, "state_5.sqlite"));
  const rows = db.all("SELECT id, model_provider, model FROM threads ORDER BY id");
  db.close();
  return Object.fromEntries(rows.map((r) => [r.id, [r.model_provider, r.model]]));
}

const CHATGPT_CHATS = [
  { id: "a", provider: "openai", model: "gpt-6-astra" },
  { id: "b", provider: "openai", model: "codex-auto-review" },
  { id: "c", provider: "openai", model: null },
  { id: "z", provider: "oceantoken", model: "openai/gpt-5.5" },
];

test("use codex --move-chats refuses while Codex runs and changes nothing", { skip: NO_SQLITE }, async () => {
  const home = tempHome();
  const codex = codexHomeWithChats(home, CHATGPT_CHATS);
  fs.writeFileSync(path.join(codex, "config.toml"), 'model = "gpt-6-astra"\n');
  const res = await cli(["use", "codex", "--api-key", KEY, "--move-chats"], { home, respond: APP_RUNNING });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /Chats .*Codex is running \(ChatGPT, codex\); nothing changed/);
  assert.match(res.out, /Quit the ChatGPT app/);
  assert.equal(read(path.join(codex, "config.toml")), 'model = "gpt-6-astra"\n', "not even the provider was switched");
  assert.deepEqual(threadsIn(codex).a, ["openai", "gpt-6-astra"]);
  assert.ok(!exists(path.join(codex, "backups")));
});

test("use codex --move-chats re-points ChatGPT chats after a backup; unuse --move-chats puts them back", { skip: NO_SQLITE }, async () => {
  const home = tempHome();
  const codex = codexHomeWithChats(home, CHATGPT_CHATS);
  const models = ["openai/gpt-6-astra", "openai/gpt-5.5"];

  const dry = await cli(["use", "codex", "--api-key", KEY, "--move-chats", "--dry-run"], { home, respond: NOT_RUNNING, models });
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Chats .*would move 2 chats to OceanToken/);
  assert.deepEqual(threadsIn(codex).a, ["openai", "gpt-6-astra"]);

  const res = await cli(["use", "codex", "--api-key", KEY, "--move-chats"], { home, respond: NOT_RUNNING, models });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(threadsIn(codex), {
    a: ["oceantoken", "openai/gpt-6-astra"],
    b: ["openai", "codex-auto-review"],
    c: ["oceantoken", null],
    z: ["oceantoken", "openai/gpt-5.5"],
  });
  assert.match(res.out, /Chats {5}2 moved to OceanToken/);
  assert.match(res.out, /1 chat on codex-auto-review stay on your ChatGPT plan/);
  const [backup] = fs.readdirSync(path.join(codex, "backups"));
  const saved = sqliteFor(path.join(codex, "backups", backup, "state_5.sqlite"));
  assert.equal(saved.all("SELECT model_provider FROM threads WHERE id = 'a'")[0].model_provider, "openai", "the backup is the list before the move");
  saved.close();
  assert.deepEqual(readJson(path.join(codex, "backups", backup, "manifest.json")).moved.map((m) => m.id), ["a", "c"]);
  assert.equal(readJson(path.join(home, ".oceantoken", "cli-state.json")).codex.moved.a.model, "gpt-6-astra");

  const back = await cli(["unuse", "codex", "--move-chats"], { home, respond: NOT_RUNNING });
  assert.equal(back.code, 0, back.out);
  assert.deepEqual(threadsIn(codex), {
    a: ["openai", "gpt-6-astra"],
    b: ["openai", "codex-auto-review"],
    c: ["openai", null],
    z: ["openai", "gpt-5.5"],
  });
  assert.deepEqual(readJson(path.join(home, ".oceantoken", "cli-state.json")).codex.moved, {});
});

test("unuse --move-chats blanks OceanToken's reasoning in the chat files, keeps lengths, and backs the files up", { skip: NO_SQLITE }, async () => {
  const home = tempHome();
  const file = "sessions/2026/10/18/rollout-2026-10-18T10-00-00-33333333-3333-3333-3333-333333333333.jsonl";
  const codex = codexHomeWithChats(
    home,
    [
      { id: "33333333-3333-3333-3333-333333333333", provider: "oceantoken", model: "openai/gpt-6-astra", file },
      { id: "d", provider: "oceantoken", model: "deepseek/deepseek-v4-pro" },
    ],
    { [file]: MIXED },
  );
  const before = fs.statSync(path.join(codex, file));
  const res = await cli(["unuse", "codex", "--move-chats"], { home, respond: NOT_RUNNING });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /1 chat back on your ChatGPT plan \(1 hidden reasoning item made on OceanToken blanked\)/);
  assert.match(res.out, /1 chat on deepseek\/deepseek-v4-pro stay on OceanToken/);
  const after = read(path.join(codex, file));
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(MIXED));
  assert.ok(after.includes("gAAAAB-chatgpt") && !after.includes("gAAAAB-oceantoken"));
  assert.ok(Math.abs(fs.statSync(path.join(codex, file)).mtimeMs - before.mtimeMs) < 1, "the chat keeps its place in Codex's list");
  const [backup] = fs.readdirSync(path.join(codex, "backups"));
  assert.equal(read(path.join(codex, "backups", backup, "chats", file)), MIXED);
  assert.deepEqual(threadsIn(codex), {
    "33333333-3333-3333-3333-333333333333": ["openai", "gpt-6-astra"],
    d: ["oceantoken", "deepseek/deepseek-v4-pro"],
  });
});

test("compressed chat files are read and written back compressed", { skip: NO_SQLITE || (typeof zlib.zstdCompressSync !== "function" && "needs Node 22.15+ for zstd") }, async () => {
  const home = tempHome();
  const file = "sessions/2026/10/18/rollout-2026-10-18T10-00-00-44444444-4444-4444-4444-444444444444.jsonl";
  const codex = codexHomeWithChats(home, [{ id: "44444444-4444-4444-4444-444444444444", provider: "oceantoken", model: "openai/gpt-6-astra", file }]);
  fs.mkdirSync(path.dirname(path.join(codex, file)), { recursive: true });
  // Codex keeps the .jsonl path in its list after compressing the file to .jsonl.zst.
  fs.writeFileSync(path.join(codex, `${file}.zst`), zlib.zstdCompressSync(Buffer.from(MIXED)));
  const res = await cli(["unuse", "codex", "--move-chats"], { home, respond: NOT_RUNNING });
  assert.equal(res.code, 0, res.out);
  const text = zlib.zstdDecompressSync(fs.readFileSync(path.join(codex, `${file}.zst`))).toString();
  assert.equal(Buffer.byteLength(text), Buffer.byteLength(MIXED));
  assert.ok(!text.includes("gAAAAB-oceantoken"));
});

test("without --move-chats: a note on a pipe, and on a terminal an offer that defaults to no", { skip: NO_SQLITE }, async () => {
  const home = tempHome();
  const codex = codexHomeWithChats(home, CHATGPT_CHATS);
  const quiet = await cli(["use", "codex", "--api-key", KEY], { home, respond: NOT_RUNNING });
  assert.match(quiet.out, /Your 3 existing chats stay on your ChatGPT plan/);
  assert.equal(threadsIn(codex).a[0], "openai");

  const asked = [];
  const no = await cli(["use", "codex", "--api-key", KEY], { home, respond: NOT_RUNNING, confirm: async (q) => (asked.push(q), false) });
  assert.match(asked[0], /You have 3 chats from your ChatGPT plan/);
  assert.match(no.out, /run `use codex --move-chats`/);
  assert.equal(threadsIn(codex).a[0], "openai");

  const yes = await cli(["use", "codex", "--api-key", KEY], { home, respond: NOT_RUNNING, confirm: async () => true, models: ["openai/gpt-6-astra"] });
  assert.equal(yes.code, 0, yes.out);
  assert.equal(threadsIn(codex).a[0], "oceantoken");

  const off = await cli(["unuse", "codex"], { home, respond: NOT_RUNNING });
  assert.match(off.out, /3 chats are on OceanToken and will not open without it/);
});

test("without node:sqlite (Node 18 / 20) the sqlite3 command reads, writes and backs up the same way", { skip: which("sqlite3") ? false : "no sqlite3 command" }, () => {
  const dir = tempHome();
  const file = path.join(dir, "state_5.sqlite");
  const db = fromCommand(which("sqlite3"), file);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, model TEXT);");
  db.exec(`INSERT INTO threads VALUES ('a', '/x', 'openai', ${sqlValue("it's")}), ('b', '/y', 'openai', NULL);`);
  assert.deepEqual(db.all("SELECT id, model FROM threads ORDER BY id"), [{ id: "a", model: "it's" }, { id: "b", model: null }]);
  db.exec(`VACUUM INTO ${sqlValue(path.join(dir, "copy.sqlite"))};`);
  assert.deepEqual(fromCommand(which("sqlite3"), path.join(dir, "copy.sqlite"), true).all("SELECT count(*) AS n FROM threads"), [{ n: 2 }]);
  assert.deepEqual(db.all("SELECT id FROM threads WHERE model = 'none'"), []);
});
