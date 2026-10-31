import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cleanChats, cleanTranscript } from "../src/lib/claude-chats.js";
import { KEY, cli, exists, filesUnder, read, readJson, tempHome } from "./helpers.js";

// Board 2026-10-30: a chat that ran on OceanToken failed once it went back to the Claude
// plan ("tool_use.provider_specific_fields: Extra inputs are not permitted").
const line = (entry) => JSON.stringify(entry);
const toolUse = (id, extra = {}) => ({ type: "tool_use", id, name: "Bash", input: { command: "ls" }, ...extra });
const assistant = (content) => ({ type: "assistant", uuid: `u-${content.length}`, message: { role: "assistant", content } });
const USER = line({ type: "user", message: { role: "user", content: "talk about provider_specific_fields, 你好" } });
const OK = line(assistant([toolUse("t0", { caller: { type: "direct" } })]));
const BAD = line(assistant([{ type: "text", text: "hi" }, toolUse("t1", { provider_specific_fields: null })]));
const SIGNED = line(assistant([toolUse("t2", { provider_specific_fields: { thought_signature: "s" } }), toolUse("t3", { provider_specific_fields: {} })]));

function chatHome(lines) {
  const home = tempHome();
  const file = path.join(home, ".claude", "projects", "-Users-me-app", "chat-1.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { home, file };
}

test("cleanTranscript takes the field out of content blocks only and leaves every other line byte for byte", () => {
  const text = `${[USER, OK, BAD, SIGNED].join("\n")}\n`;
  const res = cleanTranscript(Buffer.from(text));
  assert.equal(res.blocks, 3);
  const out = res.bytes.toString("utf8").split("\n");
  assert.equal(out.length, 5, "same number of lines, final newline kept");
  assert.equal(out[0], USER, "text that only mentions the field is untouched");
  assert.equal(out[1], OK, "caller and other API fields stay");
  assert.deepEqual(JSON.parse(out[2]).message.content[1], toolUse("t1"));
  assert.deepEqual(JSON.parse(out[3]).message.content, [toolUse("t2"), toolUse("t3")]);
  assert.equal(out[4], "");
  assert.equal(cleanTranscript(res.bytes), null, "a clean transcript is left alone");
  assert.equal(cleanTranscript(Buffer.from(`${USER}\n${OK}`)), null);
  assert.equal(cleanTranscript(Buffer.from(`{broken provider_specific_fields\n${BAD}`)).blocks, 1, "a broken line is kept as it is");
});

test("cleanChats lists without writing, then cleans with a backup of exactly what was there", () => {
  const { home, file } = chatHome([USER, BAD, SIGNED]);
  const sub = path.join(path.dirname(file), "chat-1", "subagents", "agent-a.jsonl");
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, `${BAD}\n`);
  const before = read(file);
  const claudeDir = path.join(home, ".claude");

  assert.deepEqual(cleanChats(claudeDir).map((c) => [path.basename(c.file), c.chat, c.blocks]).sort(), [["agent-a.jsonl", "-Users-me-app/chat-1", 1], ["chat-1.jsonl", "-Users-me-app/chat-1", 3]], "a subagent's transcript belongs to its chat");
  assert.equal(read(file), before, "listing writes nothing");

  const backupDir = path.join(claudeDir, "backups", "b");
  assert.equal(cleanChats(claudeDir, { backupDir }).length, 2);
  assert.ok(!read(file).includes("provider_specific_fields\":"), "no block keeps the field");
  assert.equal(read(path.join(backupDir, "projects", "-Users-me-app", "chat-1.jsonl")), before);
  assert.ok(exists(path.join(backupDir, "projects", "-Users-me-app", "chat-1", "subagents", "agent-a.jsonl")));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the chat keeps its permissions");
  assert.deepEqual(filesUnder(path.dirname(file)).filter((f) => f.includes(".tmp-")), [], "no temp file left");
  assert.deepEqual(cleanChats(claudeDir, { backupDir: path.join(claudeDir, "backups", "c") }), []);
  assert.ok(!exists(path.join(claudeDir, "backups", "c")), "no backup folder when nothing changed");
});

test("unuse claude-code cleans chats that ran on OceanToken, says how to reopen them, and a dry run changes nothing", async () => {
  const { home, file } = chatHome([USER, BAD]);
  assert.equal((await cli(["use", "claude-code", "--api-key", KEY], { home })).code, 0);
  const before = read(file);

  const dry = await cli(["unuse", "claude-code", "--dry-run"], { home });
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /would clean 1 chat \(1 tool call with a field your Claude plan refuses\)/);
  assert.equal(read(file), before);

  const off = await cli(["unuse", "claude-code"], { home });
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /Chats {5}1 chat cleaned, so they continue on your Claude plan/);
  assert.match(off.out, /Backup {4}~\/\.claude\/backups\/oceantoken-cli-\d{8}T\d{6}Z/);
  assert.match(off.out, /reopen your chat from the past conversations/);
  assert.match(off.out, /claude --continue/);
  assert.deepEqual(JSON.parse(read(file).split("\n")[1]).message.content[1], toolUse("t1"));
  assert.ok(!off.out.includes(KEY));

  // Nothing left to undo, and the chats are already clean.
  const again = await cli(["unuse", "claude-code"], { home });
  assert.match(again.out, /Chats {5}ready for your Claude plan/);
  assert.match(again.out, /nothing to undo/);
});

test("unuse claude-code also cleans chats when the gateway was set up by hand", async () => {
  const { home, file } = chatHome([BAD]);
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  const off = await cli(["unuse", "claude-code"], { home });
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /cleaned 1 chat/);
  assert.match(off.out, /nothing to undo/);
  assert.ok(!read(file).includes("provider_specific_fields"));
  assert.deepEqual(readJson(path.join(home, ".claude", "settings.json")), { theme: "dark" }, "settings untouched");
});

test("findClaude finds the desktop app's copy in its newer <version>/<build>/ folder", { skip: process.platform !== "darwin" }, async () => {
  const { findClaude } = await import("../src/clients/claude-code.js");
  const home = tempHome();
  const base = path.join(home, "Library", "Application Support", "Claude", "claude-code");
  const old = path.join(base, "2.1.290", "claude.app", "Contents", "MacOS", "claude");
  const now = path.join(base, "2.1.308", "a93ded4b1b47", "claude.app", "Contents", "MacOS", "claude");
  for (const f of [old, now]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "");
  }
  const ctx = { which: () => null, env: {}, path: (...p) => path.join(home, ...p) };
  assert.equal(findClaude(ctx), now, "the newest version wins, wherever its binary sits");
});
