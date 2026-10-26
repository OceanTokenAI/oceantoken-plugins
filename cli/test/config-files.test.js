import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { codexBlock, removeBlock, upsertCodexBlock, upsertHermesServer } from "../src/lib/blocks.js";
import { removeJsonEntry, stripJsonc, upsertJsonEntry } from "../src/lib/json-config.js";
import { installSkills, removeSkills } from "../src/lib/skills.js";
import { run, ttyCommand } from "../src/lib/run.js";
import { backupFile, writeFileSafely } from "../src/lib/fsutil.js";
import { createContext } from "../src/context.js";
import { KEY, exists, read, readJson, tempHome } from "./helpers.js";

const URL = "https://mcp.oceantoken.ai/mcp";

test("a JSON config is created, extended, left unchanged and cleaned up", () => {
  const file = path.join(tempHome(), "cfg", "mcp.json");
  assert.equal(upsertJsonEntry(file, ["mcpServers", "oceantoken"], { url: URL }).status, "created");
  fs.writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { other: { url: "x" } } }));
  assert.equal(upsertJsonEntry(file, ["mcpServers", "oceantoken"], { url: URL }).status, "added");
  assert.deepEqual(readJson(file), { theme: "dark", mcpServers: { other: { url: "x" }, oceantoken: { url: URL } } });
  assert.equal(upsertJsonEntry(file, ["mcpServers", "oceantoken"], { url: URL }).status, "unchanged");
  assert.ok(exists(`${file}.bak-oceantoken`), "an existing file is backed up before it is rewritten");
  assert.equal(removeJsonEntry(file, ["mcpServers", "oceantoken"]).status, "removed");
  assert.deepEqual(readJson(file), { theme: "dark", mcpServers: { other: { url: "x" } } });
  assert.equal(removeJsonEntry(file, ["mcpServers", "oceantoken"]).status, "absent");
});

test("a JSON config with comments is never rewritten", () => {
  const file = path.join(tempHome(), "opencode.jsonc");
  const text = '{\n  // my settings\n  "theme": "dark",\n}\n';
  fs.writeFileSync(file, text);
  const res = upsertJsonEntry(file, ["mcp", "oceantoken"], { type: "remote", url: URL });
  assert.equal(res.status, "manual");
  assert.match(res.snippet, /"oceantoken"/);
  assert.equal(read(file), text);
  assert.equal(stripJsonc('{"a": "http://x", // c\n "b": [1,],}'), '{"a": "http://x", \n "b": [1]}');
});

test("the first backup keeps the original for good; later writes leave timestamped backups (QA-118)", () => {
  const dir = tempHome();
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, "original");
  writeFileSafely(file, "first");
  writeFileSafely(file, "second");
  writeFileSafely(file, "third", { secret: true });
  assert.equal(read(file), "third");
  assert.equal(read(`${file}.bak-oceantoken`), "original", "the user's own file is never overwritten");
  const later = fs.readdirSync(dir).filter((f) => f.startsWith("mcp.json.bak-oceantoken-")).sort();
  assert.equal(later.length, 2);
  assert.match(later[0], /^mcp\.json\.bak-oceantoken-\d{8}T\d{6}Z(-\d+)?$/);
  assert.deepEqual(later.map((f) => read(path.join(dir, f))).sort(), ["first", "second"]);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes(".tmp-")), "no temp file is left behind");
});

test("backups in the same second get their own names instead of replacing each other", () => {
  const file = path.join(tempHome(), "config.toml");
  const now = new Date("2026-10-04T08:15:30.123Z");
  const names = ["a", "b", "c"].map((text) => {
    fs.writeFileSync(file, text);
    return path.basename(backupFile(file, { now }));
  });
  assert.deepEqual(names, ["config.toml.bak-oceantoken", "config.toml.bak-oceantoken-20261004T081530Z", "config.toml.bak-oceantoken-20261004T081530Z-2"]);
  assert.equal(read(`${file}.bak-oceantoken`), "a");
});

test("a backup is owner-only, since the file it copies may hold a key", { skip: process.platform === "win32" }, () => {
  const file = path.join(tempHome(), "mcp.json");
  fs.writeFileSync(file, '{"headers":{"Authorization":"Bearer k"}}', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.equal(fs.statSync(backupFile(file)).mode & 0o777, 0o600);
});

test("connect, disconnect and connect again keep the user's original config (QA-118)", () => {
  const file = path.join(tempHome(), ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file));
  const original = `${JSON.stringify({ mcpServers: { github: { url: "g" } } })}\n`;
  fs.writeFileSync(file, original);
  upsertJsonEntry(file, ["mcpServers", "oceantoken"], { url: URL });
  removeJsonEntry(file, ["mcpServers", "oceantoken"]);
  upsertJsonEntry(file, ["mcpServers", "oceantoken"], { url: URL, headers: { Authorization: "Bearer k" } });
  assert.equal(read(`${file}.bak-oceantoken`), original);
});

test("input reaches the child on stdin, not in its arguments", async () => {
  const res = await run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: `{"k":"${KEY}"}` });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, `{"k":"${KEY}"}`);
});

test("a step that would put the API key on a command line is refused before anything runs (QA-093)", async () => {
  const calls = [];
  const ctx = createContext({
    client: { id: "x", label: "X" },
    home: tempHome(),
    apiKey: KEY,
    quiet: true,
    runner: async (...args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(ctx.exec("MCP server", "tool", ["--header", `Authorization: Bearer ${KEY}`]), /refusing to pass the API key/);
  await assert.rejects(ctx.exec("MCP server", "tool", ["set", JSON.stringify({ headers: { Authorization: `Bearer ${KEY}` } })]), /refusing/);
  await assert.rejects(ctx.query("tool", ["--token", KEY]), /refusing/);
  assert.equal(calls.length, 0);
  await ctx.exec("MCP server", "tool", ["patch", "--stdin"], { input: KEY });
  assert.equal(calls[0][2].input, KEY, "stdin is the way to hand it over");
});

test("a key file is created owner-only", { skip: process.platform === "win32" }, () => {
  const file = path.join(tempHome(), "mcp.json");
  upsertJsonEntry(file, ["mcpServers", "oceantoken"], { url: URL, headers: { Authorization: "Bearer k" } }, { secret: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the Codex block is appended, replaced and removed, and a hand-written table is left alone", () => {
  const first = upsertCodexBlock('model = "gpt-5.5"\n', codexBlock(URL));
  assert.equal(first.status, "added");
  assert.match(first.text, /^model = "gpt-5.5"\n\n# OceanToken MCP server/m);
  const withKey = upsertCodexBlock(first.text, codexBlock(URL, { Authorization: "Bearer k" }));
  assert.equal(withKey.status, "updated");
  assert.match(withKey.text, /http_headers = \{ "Authorization" = "Bearer k" \}/);
  assert.equal(withKey.text.match(/\[mcp_servers\.oceantoken\]/g).length, 1);
  const removed = removeBlock(withKey.text);
  assert.equal(removed.status, "removed");
  assert.equal(removed.text.trim(), 'model = "gpt-5.5"');
  const hand = '[mcp_servers.oceantoken]\nurl = "https://example"\n';
  assert.equal(upsertCodexBlock(hand, codexBlock(URL)).status, "manual");
});

test("the Hermes server goes under mcp_servers at the file's own indent", () => {
  const fresh = upsertHermesServer(null, URL);
  assert.equal(fresh.status, "created");
  assert.equal(fresh.text, `mcp_servers:\n  # OceanToken MCP server (added by @oceantoken/cli)\n  oceantoken:\n    url: "${URL}"\n    auth: oauth\n  # end OceanToken\n`);

  const existing = "model: x\nmcp_servers:\n    github:\n        url: https://gh\nskills: []\n";
  const added = upsertHermesServer(existing, URL);
  assert.equal(added.status, "added");
  assert.match(added.text, /^mcp_servers:\n {4}# OceanToken[^\n]*\n {4}oceantoken:\n {8}url: /m);
  assert.match(added.text, /github:\n {8}url: https:\/\/gh\nskills: \[\]/);
  assert.equal(upsertHermesServer(added.text, URL).status, "unchanged");
  assert.equal(removeBlock(added.text).text, existing);

  assert.equal(upsertHermesServer("mcp_servers:\n  oceantoken:\n    url: x\n", URL).status, "manual");
  assert.equal(upsertHermesServer("mcp_servers: {}\n", URL).status, "manual");
  assert.equal(upsertHermesServer("mcp_servers:\n\tgithub: {}\n", URL).status, "manual");
  assert.equal(upsertHermesServer("a: 1\n", URL).text, `a: 1\n\n${fresh.text}`);
});

test("skills are installed with an owner mark, and only owned folders are replaced or removed", () => {
  const dir = path.join(tempHome(), "skills");
  fs.mkdirSync(path.join(dir, "oceantoken-setup"), { recursive: true });
  fs.writeFileSync(path.join(dir, "oceantoken-setup", "SKILL.md"), "mine");
  const res = installSkills(dir);
  assert.deepEqual(res.installed, ["oceantoken-media", "oceantoken-models"]);
  assert.deepEqual(res.skipped, ["oceantoken-setup"]);
  assert.match(read(path.join(dir, "oceantoken-media", "SKILL.md")), /^---\nname: oceantoken-media/);
  assert.ok(!exists(path.join(dir, "oceantoken-media", "agents")), "Codex-only metadata is not copied");
  assert.deepEqual(removeSkills(dir).removed, ["oceantoken-media", "oceantoken-models"]);
  assert.equal(read(path.join(dir, "oceantoken-setup", "SKILL.md")), "mine");
});

test("a terminal is borrowed from `script`, fed by a pipe, with each platform's own syntax", () => {
  const env = { PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin" + path.delimiter + "/bin" };
  const mac = ttyCommand("/Apps/claude", ["mcp", "login", "plugin:oceantoken:oceantoken"], { platform: "darwin", env });
  if (!mac) return; // no `script` on this machine (Windows)
  assert.equal(mac.cmd, "sh");
  assert.match(mac.args[1], /^sleep 86400 \| \{ script -q \/dev\/null "\$@"; rc=\$\?; pkill -P \$\$ sleep/);
  assert.deepEqual(mac.args.slice(2), ["sh", "/Apps/claude", "mcp", "login", "plugin:oceantoken:oceantoken"]);
  const linux = ttyCommand("/opt/My Claude/claude", ["mcp", "login", "x's"], { platform: "linux", env });
  assert.match(linux.args[1], /script -q -e -c "\$1" \/dev\/null/);
  assert.deepEqual(linux.args.slice(2), ["sh", "'/opt/My Claude/claude' mcp login 'x'\\''s'"]);
  assert.equal(ttyCommand("claude", [], { platform: "win32", env }), null);
});

test(
  "the wrapped command really gets a terminal and its exit status comes back",
  { skip: !["darwin", "linux"].includes(process.platform) || process.stdin.isTTY },
  async () => {
    const res = await run("sh", ["-c", "[ -t 0 ] && echo has-tty || echo no-tty; exit 3"], { tty: true });
    assert.match(res.stdout, /has-tty/);
    assert.equal(res.code, 3);
  },
);
