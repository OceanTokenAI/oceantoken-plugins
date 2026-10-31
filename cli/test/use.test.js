import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyCodexProvider, revertCodexProvider } from "../src/lib/provider.js";
import { KEY, assertKeyNotInArgv, cli, exists, read, readJson, tempHome } from "./helpers.js";

const BASE = "https://api.oceantoken.ai";
const USER_TOML = 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.github]\nurl = "https://g"\n';

test("codex: provider keys go above the first table, the user's model line is parked, revert restores the file", () => {
  const on = applyCodexProvider(USER_TOML, { baseUrl: `${BASE}/v1`, model: "openai/gpt-5.5", auth: { headers: { Authorization: "Bearer k" } } });
  assert.equal(on.status, "added");
  const lines = on.text.split("\n");
  const firstTable = lines.findIndex((l) => l.startsWith("["));
  assert.ok(lines.indexOf('model_provider = "oceantoken"') < firstTable, "top-level keys stay top-level");
  assert.ok(lines.includes('# disabled by @oceantoken/cli: model = "gpt-5.5"'));
  assert.equal(lines.filter((l) => /^model\s*=/.test(l)).length, 1, "TOML gets one model key");
  assert.match(on.text, /\[model_providers\.oceantoken\]\nname = "OceanToken"\nbase_url = "https:\/\/api\.oceantoken\.ai\/v1"\nwire_api = "responses"\nhttp_headers = \{ "Authorization" = "Bearer k" \}/);

  const again = applyCodexProvider(on.text, { baseUrl: `${BASE}/v1`, model: "openai/gpt-5.5", auth: { headers: { Authorization: "Bearer k" } } });
  assert.equal(again.status, "unchanged");
  const other = applyCodexProvider(on.text, { baseUrl: `${BASE}/v1`, model: "deepseek/deepseek-v4-pro", auth: { envKey: "OCEANTOKEN_API_KEY" } });
  assert.equal(other.status, "updated");
  assert.match(other.text, /env_key = "OCEANTOKEN_API_KEY"/);
  assert.doesNotMatch(other.text, /http_headers/);
  assert.equal((other.text.match(/disabled by/g) || []).length, 1, "a rerun does not park lines twice");

  const off = revertCodexProvider(other.text);
  assert.equal(off.status, "removed");
  assert.equal(off.text, USER_TOML);
  assert.equal(revertCodexProvider(off.text).status, "absent");
});

test("codex: a hand-written oceantoken provider is left alone; a file without tables still gets top-level keys first", () => {
  const hand = '[model_providers.oceantoken]\nbase_url = "https://x"\n';
  assert.equal(applyCodexProvider(hand, { baseUrl: "u", model: "m", auth: { envKey: "K" } }).status, "manual");
  const flat = applyCodexProvider('approval_policy = "never"\n', { baseUrl: "u", model: "m", auth: { envKey: "K" } });
  assert.ok(flat.text.indexOf("model_provider") < flat.text.indexOf("[model_providers"));
  assert.ok(flat.text.startsWith('approval_policy = "never"'));
});

test("use codex writes config.toml with the key, never prints it, and unuse restores the original", async () => {
  const home = tempHome();
  const file = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, USER_TOML);

  const res = await cli(["use", "codex", "--api-key", KEY], { home });
  assert.equal(res.code, 0, res.out);
  assert.match(read(file), new RegExp(`"Authorization" = "Bearer ${KEY}"`));
  assert.match(read(file), /^model = "openai\/gpt-5\.5"$/m);
  assert.ok(!res.out.includes(KEY), "the key is not printed");
  assert.match(res.out, /Result {4}switched/);
  assert.match(res.out, /unuse codex/);
  assert.equal(read(`${file}.bak-oceantoken`), USER_TOML, "the original is backed up");

  const back = await cli(["unuse", "codex"], { home });
  assert.equal(back.code, 0, back.out);
  assert.equal(read(file), USER_TOML);
  // QA-118: unuse and a second use must not replace the first backup with the CLI's own output.
  assert.equal(read(`${file}.bak-oceantoken`), USER_TOML, "unuse leaves the first backup alone");
  await cli(["use", "codex", "--api-key", KEY, "--model", "deepseek/deepseek-v4-pro"], { home });
  assert.equal(read(`${file}.bak-oceantoken`), USER_TOML, "the first backup is still the user's file");
});

test("use codex --use-env-key --model stores no key", async () => {
  const home = tempHome();
  const res = await cli(["use", "codex", "--use-env-key", "--model", "deepseek/deepseek-v4-pro"], { home, env: { OCEANTOKEN_API_KEY: KEY } });
  assert.equal(res.code, 0, res.out);
  const text = read(path.join(home, ".codex", "config.toml"));
  assert.match(text, /env_key = "OCEANTOKEN_API_KEY"/);
  assert.match(text, /model = "deepseek\/deepseek-v4-pro"/);
  assert.ok(!text.includes(KEY));
});

test("use claude-code sets the env block, keeps other settings, and unuse puts back exactly what was there", async () => {
  const home = tempHome();
  const file = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file));
  const original = { theme: "dark", apiKeyHelper: "~/bin/my-key", env: { FOO: "1", ANTHROPIC_MODEL: "claude-opus-4-5" } };
  fs.writeFileSync(file, JSON.stringify(original));

  const res = await cli(["use", "claude-code", "--api-key", KEY], { home });
  assert.equal(res.code, 0, res.out);
  const on = readJson(file);
  assert.equal(on.theme, "dark");
  assert.equal(on.env.FOO, "1");
  assert.equal(on.env.ANTHROPIC_BASE_URL, BASE);
  assert.equal(on.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(on.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "anthropic/claude-sonnet-latest");
  assert.equal(on.env.ANTHROPIC_MODEL, undefined, "the user's pinned Claude model would bypass the mapping");
  assert.equal(on.apiKeyHelper, undefined, "a competing key helper is parked");
  assert.ok(!res.out.includes(KEY));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // A second run with other options must not overwrite the saved originals.
  const again = await cli(["use", "claude-code", "--api-key", KEY, "--model", "deepseek/deepseek-v4-pro"], { home });
  assert.equal(again.code, 0, again.out);
  assert.equal(readJson(file).env.ANTHROPIC_MODEL, "deepseek/deepseek-v4-pro");
  assert.equal(readJson(file).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek/deepseek-v4-pro");

  const back = await cli(["unuse", "claude-code"], { home });
  assert.equal(back.code, 0, back.out);
  assert.deepEqual(readJson(file), original);
  assert.deepEqual(readJson(`${file}.bak-oceantoken`), original, "three writes later, the first backup is the original");
  assert.match((await cli(["unuse", "claude-code"], { home })).out, /nothing to undo/);
});

test("use claude-code --use-env-key installs a key helper instead of storing the key", async () => {
  const home = tempHome();
  const res = await cli(["use", "claude-code", "--use-env-key"], { home, env: { OCEANTOKEN_API_KEY: KEY } });
  assert.equal(res.code, 0, res.out);
  const on = readJson(path.join(home, ".claude", "settings.json"));
  assert.equal(on.apiKeyHelper, "printenv OCEANTOKEN_API_KEY");
  assert.equal(on.env.ANTHROPIC_AUTH_TOKEN, undefined);
  await cli(["unuse", "claude-code"], { home });
  assert.deepEqual(readJson(path.join(home, ".claude", "settings.json")), {});
});

test("use: a rejected key writes nothing; no key without a terminal is a usage error; other agents are refused", async () => {
  const home = tempHome();
  const rejected = await cli(["use", "codex", "--api-key", KEY], { home, models: 401 });
  assert.equal(rejected.code, 1);
  assert.ok(!exists(path.join(home, ".codex", "config.toml")));
  const noKey = await cli(["use", "codex"], { home });
  assert.equal(noKey.code, 2);
  assert.match(noKey.err, /--api-key -/);
  const cursor = await cli(["use", "cursor", "--api-key", KEY], { home });
  assert.equal(cursor.code, 2);
  assert.match(cursor.err, /Supported: codex, claude-code/);
});

test("use --dry-run changes nothing", async () => {
  const home = tempHome();
  const res = await cli(["use", "claude-code", "--api-key", KEY, "--dry-run"], { home });
  assert.equal(res.code, 0, res.out);
  assert.ok(!exists(path.join(home, ".claude", "settings.json")));
  assert.ok(!exists(path.join(home, ".oceantoken")));
  assert.match(res.out, /Result {4}dry run/);
});

test("use and unuse never put the key on a command line, whichever way it is given (QA-093)", async () => {
  for (const agent of ["codex", "claude-code"]) {
    const ways = [
      { argv: ["--api-key", KEY] },
      { argv: ["--use-env-key"], env: { OCEANTOKEN_API_KEY: KEY } },
      // No flag: the keys page is opened with the runner and the key is pasted.
      { argv: [], promptKey: async () => KEY },
      { argv: ["--api-key", KEY, "--dry-run"] },
    ];
    for (const way of ways) {
      const home = tempHome();
      const label = `use ${agent} ${way.argv.join(" ") || "(pasted)"}`;
      const res = await cli(["use", agent, ...way.argv], { home, env: way.env, promptKey: way.promptKey, bins: ["codex", "claude"] });
      assert.equal(res.code, 0, `${label}: ${res.out}${res.err}`);
      assertKeyNotInArgv(assert, res, label);
      assert.ok(!res.out.includes(KEY) && !res.err.includes(KEY), `${label} printed the key`);
      // Nothing but read-only queries (Codex's own model list), never with the key.
      if (!way.promptKey) {
        const ran = res.calls.map((c) => c.args.join(" "));
        assert.ok(ran.every((a) => a === "debug models --bundled"), `${label} ran ${ran.join("; ")}`);
      }
      assertKeyNotInArgv(assert, await cli(["unuse", agent], { home, bins: ["codex", "claude"] }), `unuse ${agent}`);
    }
  }
});

test("codex: the ChatGPT app rewrote config.toml and lost the end markers; unuse still restores it", () => {
  // The shape of a real config after the app rewrote it (2026-10-20): the comment that ended
  // the top block sat before a table the app rewrote, so it is gone.
  const on = applyCodexProvider(USER_TOML, { baseUrl: `${BASE}/v1`, model: "openai/gpt-5.5", auth: { headers: { Authorization: "Bearer k" } } }).text;
  const rewritten = on
    .replace("# end OceanToken model provider\n", "")
    .replace("# end OceanToken provider table\n", "")
    .concat('\n[desktop]\nlocaleOverride = "en-US"\n');
  const off = revertCodexProvider(rewritten);
  assert.equal(off.status, "removed");
  assert.equal(off.text, `${USER_TOML}\n[desktop]\nlocaleOverride = "en-US"\n`);
  assert.doesNotMatch(off.text, /oceantoken/, "no provider line left pointing at a removed table");

  // Rerunning use on it replaces the block instead of parking our own line as the user's.
  const again = applyCodexProvider(rewritten, { baseUrl: `${BASE}/v1`, model: "openai/gpt-5.5", auth: { envKey: "K" } });
  assert.equal(again.status, "updated");
  assert.equal((again.text.match(/^model_provider = /gm) || []).length, 1);
  assert.equal((again.text.match(/^\[model_providers\.oceantoken\]/gm) || []).length, 1);
  assert.doesNotMatch(again.text, /disabled by @oceantoken\/cli: model_provider/);
  assert.equal(revertCodexProvider(again.text).text, `${USER_TOML}\n[desktop]\nlocaleOverride = "en-US"\n`);

  // A marker-less leftover `model_provider = "oceantoken"` is never brought back.
  const parked = '# disabled by @oceantoken/cli: model_provider = "oceantoken"\nmodel = "x"\n';
  assert.equal(revertCodexProvider(parked).text, 'model = "x"\n');
});

// Board 2026-10-30: people switch between their own plan and OceanToken often, so the
// key `use` was given is kept for switching back, and `status` says where each agent is.
test("switching back and forth: unuse keeps the key (owner-only), use needs none pasted, --forget-key deletes it", async () => {
  const home = tempHome();
  const file = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify({ theme: "dark" })}\n`);
  const stateFile = path.join(home, ".oceantoken", "cli-state.json");

  assert.equal((await cli(["use", "claude-code", "--api-key", KEY], { home })).code, 0);
  assert.equal(readJson(stateFile).keys["claude-code"], KEY);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600, "the kept key is owner-only");

  const off = await cli(["unuse", "claude-code"], { home });
  assert.equal(off.code, 0, off.out);
  assert.deepEqual(readJson(file), { theme: "dark" }, "the user's settings are back exactly");
  assert.match(off.out, /Key {7}kept in /);
  assert.match(off.out, /Back {6}npx -y @oceantoken\/cli@latest use claude-code/);
  assert.match(off.out, /Developer: Reload Window/);

  // No --api-key, no terminal to paste into: the kept key is used.
  const on = await cli(["use", "claude-code"], { home });
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, /kept from your last `use claude-code`/);
  assert.equal(readJson(file).env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.ok(!on.out.includes(KEY) && !off.out.includes(KEY), "the key is never printed");

  const forget = await cli(["unuse", "claude-code", "--forget-key"], { home });
  assert.equal(forget.code, 0, forget.out);
  assert.match(forget.out, /Key {7}deleted/);
  assert.equal(readJson(stateFile).keys, undefined);
  const again = await cli(["use", "claude-code"], { home });
  assert.equal(again.code, 2, "nothing kept: a key is needed again");
  assert.match(again.err, /no API key/);
});

test("a kept key OceanToken rejects is dropped; --use-env-key keeps nothing", async () => {
  const home = tempHome();
  await cli(["use", "claude-code", "--api-key", KEY], { home });
  await cli(["unuse", "claude-code"], { home });
  const rejected = await cli(["use", "claude-code"], { home, models: 401 });
  assert.equal(rejected.code, 1, rejected.out);
  assert.equal(readJson(path.join(home, ".oceantoken", "cli-state.json")).keys, undefined);

  const envHome = tempHome();
  await cli(["use", "claude-code", "--use-env-key"], { home: envHome, env: { OCEANTOKEN_API_KEY: KEY } });
  assert.ok(!exists(path.join(envHome, ".oceantoken", "cli-state.json")) || !read(path.join(envHome, ".oceantoken", "cli-state.json")).includes(KEY));
});

test("status says what Claude Code and Codex run on now", async () => {
  const home = tempHome();
  const before = await cli(["status"], { home });
  assert.equal(before.code, 0, before.err);
  assert.match(before.out, /claude-code +not OceanToken - its own sign-in \(your Claude plan\)/);
  assert.match(before.out, /codex +not OceanToken - its own sign-in \(your ChatGPT plan\)/);

  await cli(["use", "claude-code", "--api-key", KEY], { home });
  await cli(["use", "codex", "--api-key", KEY], { home });
  const after = await cli(["status", "--json"], { home });
  const rows = JSON.parse(after.out);
  assert.deepEqual(rows.map((r) => [r.agent, r.oceantoken, r.keyKept]), [["codex", true, true], ["claude-code", true, true]].filter((r) => rows.some((x) => x.agent === r[0])).sort((a, b) => rows.findIndex((x) => x.agent === a[0]) - rows.findIndex((x) => x.agent === b[0])));
  assert.ok(!after.out.includes(KEY), "status never prints a key");
});
