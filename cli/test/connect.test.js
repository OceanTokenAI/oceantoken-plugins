import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLIENTS } from "../src/clients/index.js";
import { apiBaseFor } from "../src/lib/apikey.js";
import { KEY, assertKeyNotInArgv, cli, exists, filesUnder, read, readJson, tempHome } from "./helpers.js";

const URL = "https://mcp.oceantoken.ai/mcp";
const cmdline = (c) => [path.basename(c.cmd), ...c.args].join(" ");

test("cursor: server entry and skills are written, a rerun changes nothing, disconnect removes both", async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".cursor"));
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { github: { url: "g" } } }));

  const first = await cli(["connect", "cursor"], { home });
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(readJson(path.join(home, ".cursor", "mcp.json")).mcpServers, { github: { url: "g" }, oceantoken: { url: URL } });
  assert.ok(exists(path.join(home, ".cursor", "skills", "oceantoken-media", "SKILL.md")));
  assert.match(first.out, /Result {4}connected/);
  assert.match(first.out, /Tools & MCP/);
  assert.doesNotMatch(first.out, new RegExp(home), "paths are shown relative to ~");

  const again = await cli(["connect", "cursor"], { home });
  assert.match(again.out, /mcp\.json \(unchanged\)/);

  const gone = await cli(["disconnect", "cursor"], { home });
  assert.equal(gone.code, 0);
  assert.deepEqual(readJson(path.join(home, ".cursor", "mcp.json")).mcpServers, { github: { url: "g" } });
  assert.ok(!exists(path.join(home, ".cursor", "skills", "oceantoken-media")));
});

test("an API key goes into the config as a bearer header and never into the output", async () => {
  const home = tempHome();
  const res = await cli(["connect", "cursor", "--api-key", KEY, "--json"], { home });
  assert.equal(res.code, 0, res.out);
  const entry = readJson(path.join(home, ".cursor", "mcp.json")).mcpServers.oceantoken;
  assert.deepEqual(entry, { url: URL, headers: { Authorization: `Bearer ${KEY}` } });
  assert.ok(!res.out.includes(KEY), "the key is not printed");
  const report = JSON.parse(res.out);
  assert.equal(report.auth, "api-key");
  assert.equal(report.signIn, "not needed (API key)");
  assert.equal(report.result, "connected");
});

test("a rejected API key stops before anything is written", async () => {
  const home = tempHome();
  const res = await cli(["connect", "cursor", "--api-key", KEY], { home, models: 401 });
  assert.equal(res.code, 1);
  assert.match(res.out, /API key .*rejected/);
  assert.ok(!exists(path.join(home, ".cursor", "mcp.json")));
});

const keyChecks = (res) => res.fetched.filter((f) => f.url.endsWith("/v1/models"));

test("the API key is checked against the API that goes with --url, never against prod for another server", async () => {
  const prod = await cli(["connect", "cursor", "--api-key", KEY]);
  assert.deepEqual(keyChecks(prod), [{ url: "https://api.oceantoken.ai/v1/models", auth: `Bearer ${KEY}` }]);

  const dev = await cli(["connect", "cursor", "--api-key", KEY, "--url", "https://mcp.dev.example.com/mcp"]);
  assert.deepEqual(keyChecks(dev).map((f) => f.url), ["https://api.dev.example.com/v1/models"]);
  assert.equal(dev.code, 0, dev.out);

  const rejected = await cli(["connect", "cursor", "--api-key", KEY, "--url", "https://mcp.dev.example.com/mcp"], { models: 401 });
  assert.equal(rejected.code, 1);
  assert.match(rejected.out, /API key .*rejected by api\.dev\.example\.com/);

  // A local or self-hosted server has no matching API: the key is not checked, not sent
  // anywhere but that server's config entry, and a key prod would reject is not reported as rejected.
  const home = tempHome();
  const local = await cli(["connect", "cursor", "--api-key", KEY, "--url", "http://127.0.0.1:8765/mcp"], { home, models: 401 });
  assert.deepEqual(keyChecks(local), []);
  assert.ok(local.fetched.every((f) => f.auth === null), "no request carries the key");
  assert.equal(local.code, 0, local.out);
  assert.match(local.out, /API key .*not checked/);
  assert.deepEqual(readJson(path.join(home, ".cursor", "mcp.json")).mcpServers.oceantoken, {
    url: "http://127.0.0.1:8765/mcp",
    headers: { Authorization: `Bearer ${KEY}` },
  });
});

test("apiBaseFor pairs mcp.<domain> with api.<domain> and nothing else", () => {
  assert.equal(apiBaseFor("https://mcp.oceantoken.ai/mcp"), "https://api.oceantoken.ai");
  assert.equal(apiBaseFor("https://mcp.staging.oceantoken.ai:8443/mcp"), "https://api.staging.oceantoken.ai:8443");
  assert.equal(apiBaseFor("http://127.0.0.1:8765/mcp"), null);
  assert.equal(apiBaseFor("https://tools.example.com/mcp"), null);
  assert.equal(apiBaseFor("not a url"), null);
});

test("a malformed key, an unknown client and a missing client are usage errors", async () => {
  assert.equal((await cli(["connect", "cursor", "--api-key", "hello"])).code, 2);
  const unknown = await cli(["connect", "notepad"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Supported: codex, claude-code, cursor/);
  assert.equal((await cli(["connect"])).code, 2);
  assert.equal((await cli(["connect", "claude"], { bins: ["claude"] })).code, 0, "aliases resolve");
});

test("codex: marketplace, plugin, then the native OAuth sign-in in the user's terminal", async () => {
  const res = await cli(["connect", "codex"], { bins: ["codex"] });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(res.calls.map(cmdline), [
    "codex plugin marketplace add OceanTokenAI/oceantoken-plugins",
    "codex plugin marketplace upgrade oceantoken",
    "codex plugin add oceantoken@oceantoken",
    "codex mcp login oceantoken",
  ]);
  assert.equal(res.calls[3].inherit, true);
  assert.match(res.out, /Sign-in {3}done/);
});

test("codex with --no-login configures only and says how to sign in", async () => {
  const res = await cli(["connect", "codex", "--no-login"], { bins: ["codex"] });
  assert.ok(!res.calls.some((c) => c.args.includes("login")));
  assert.match(res.out, /codex mcp login oceantoken/);
});

test("codex with a key: a marked config.toml block and skills in ~/.agents; OAuth again removes the block", async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5.5"\n');
  const keyed = await cli(["connect", "codex", "--api-key", KEY], { home, bins: ["codex"] });
  assert.equal(keyed.code, 0, keyed.out);
  const toml = read(path.join(home, ".codex", "config.toml"));
  assert.match(toml, /\[mcp_servers\.oceantoken\]\nurl = "https:\/\/mcp\.oceantoken\.ai\/mcp"\nhttp_headers = \{ "Authorization" = "Bearer sk-/);
  assert.equal(keyed.calls.length, 0, "no plugin and no sign-in with a key");
  assert.ok(exists(path.join(home, ".agents", "skills", "oceantoken-models", "SKILL.md")));

  const oauth = await cli(["connect", "codex", "--no-login"], { home, bins: ["codex"] });
  assert.equal(oauth.code, 0);
  assert.equal(read(path.join(home, ".codex", "config.toml")).trim(), 'model = "gpt-5.5"');
});

test("a missing host CLI fails with install advice", async () => {
  const res = await cli(["connect", "codex"]);
  assert.equal(res.code, 1);
  assert.match(res.out, /npm install -g @openai\/codex/);
});

test("a failing host command fails the connect and shows its output", async () => {
  const res = await cli(["connect", "codex"], {
    bins: ["codex"],
    respond: (cmd, args) =>
      args.join(" ") === "plugin add oceantoken@oceantoken" ? { code: 3, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" },
  });
  assert.equal(res.code, 1);
  assert.match(res.out, /codex plugin add oceantoken@oceantoken exited 3: boom/);
  assert.ok(!res.calls.some((c) => c.args.includes("login")), "no sign-in after a failed install");
});

test("claude-code: idempotent plugin install, then claude mcp login with a terminal", async () => {
  const res = await cli(["connect", "claude-code"], {
    bins: ["claude"],
    respond: (cmd, args) =>
      args[1] === "install"
        ? { code: 1, stdout: 'Plugin "oceantoken@oceantoken" is already installed', stderr: "" }
        : args.join(" ") === "mcp list"
          ? { code: 0, stdout: "plugin:oceantoken:oceantoken: https://mcp.oceantoken.ai/mcp (HTTP) - ! Needs authentication\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
  });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(res.calls.map(cmdline), [
    "claude plugin marketplace add OceanTokenAI/oceantoken-plugins",
    "claude plugin marketplace update oceantoken",
    "claude plugin install oceantoken@oceantoken",
    "claude plugin update oceantoken@oceantoken",
    "claude mcp list",
    "claude mcp login plugin:oceantoken:oceantoken",
  ]);
  const login = res.calls.at(-1);
  assert.equal(login.inherit, true);
  assert.equal(login.tty, true, "claude mcp login refuses to run without a terminal");
  assert.match(res.out, /Sign-in {3}done/);
});

test("claude-code: an already connected plugin server is not signed in again", async () => {
  const res = await cli(["connect", "claude-code"], {
    bins: ["claude"],
    respond: (cmd, args) =>
      args.join(" ") === "mcp list"
        ? { code: 0, stdout: "plugin:oceantoken:oceantoken: https://mcp.oceantoken.ai/mcp (HTTP) - ✓ Connected\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
  });
  assert.ok(!res.calls.some((c) => c.args.includes("login")));
  assert.match(res.out, /already signed in/);
});

test("claude-code: a claude.ai OceanToken connector is reported as a duplicate", async () => {
  const res = await cli(["connect", "claude-code", "--no-login"], {
    bins: ["claude"],
    respond: (cmd, args) =>
      args.join(" ") === "mcp list"
        ? { code: 0, stdout: "claude.ai OceanToken: https://mcp.oceantoken.ai/mcp (HTTP) - ! Needs authentication\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
  });
  assert.match(res.out, /claude\.ai OceanToken\), so the tools appear twice/);
});

test("claude-code: without claude on PATH, the newest desktop-app or IDE-extension copy is used", async () => {
  const home = tempHome();
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const touch = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  };
  const desktopRoot =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Claude", "claude-code")
      : process.platform === "win32"
        ? path.join(home, "AppData", "Roaming", "Claude", "claude-code")
        : path.join(home, ".config", "Claude", "claude-code");
  const desktop =
    process.platform === "darwin"
      ? path.join(desktopRoot, "2.1.284", "claude.app", "Contents", "MacOS", "claude")
      : path.join(desktopRoot, "2.1.284", exe);
  const ide = path.join(home, ".cursor", "extensions", "anthropic.claude-code-2.1.286-darwin-arm64", "resources", "native-binary", exe);
  touch(desktop);
  touch(ide);
  const res = await cli(["connect", "claude-code", "--no-login"], { home });
  assert.equal(res.code, 0, res.out);
  assert.equal(res.calls[0].cmd, ide, "2.1.286 beats 2.1.284");
  fs.rmSync(ide);
  const desktopOnly = await cli(["connect", "claude-code", "--no-login"], { home });
  assert.equal(desktopOnly.calls[0].cmd, desktop);
  const none = await cli(["connect", "claude-code"], { home: tempHome() });
  assert.equal(none.code, 1);
  assert.match(none.out, /no Claude Code found/);
});

test("claude-code with a key: the user-scope server goes into ~/.claude.json, never onto a command line", async () => {
  const home = tempHome();
  const file = path.join(home, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { github: { type: "http", url: "g" } } }));
  const res = await cli(["connect", "claude-code", "--api-key", KEY], { home, bins: ["claude"] });
  assert.equal(res.code, 0, res.out);
  assertKeyNotInArgv(assert, res);
  assert.equal(res.calls.length, 0, "no `claude mcp add`, no `claude mcp remove`");
  assert.deepEqual(readJson(file), {
    numStartups: 3,
    mcpServers: { github: { type: "http", url: "g" }, oceantoken: { type: "http", url: URL, headers: { Authorization: `Bearer ${KEY}` } } },
  });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the file now holds a key");
  assert.ok(exists(path.join(home, ".claude", "skills", "oceantoken-setup", "SKILL.md")));
  assert.match(res.out, /MCP server .*~\/\.claude\.json \(added\)/);
  assert.ok(!res.out.includes(KEY));

  // An earlier entry (from `claude mcp add` in 0.2.0 or an OAuth run) is replaced in place.
  const again = await cli(["connect", "claude-code", "--api-key", KEY, "--url", "https://mcp.example.test/mcp"], { home, bins: ["claude"] });
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(readJson(file).mcpServers.oceantoken, { type: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: `Bearer ${KEY}` } });
  assert.deepEqual(readJson(file).mcpServers.github, { type: "http", url: "g" });
});

test("claude-code with a key honours CLAUDE_CONFIG_DIR and the legacy .config.json", async () => {
  const home = tempHome();
  const dir = path.join(home, "cc");
  const res = await cli(["connect", "claude-code", "--api-key", KEY], { home, bins: ["claude"], env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(res.code, 0, res.out);
  assert.equal(readJson(path.join(dir, ".claude.json")).mcpServers.oceantoken.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(exists(path.join(dir, "skills", "oceantoken-media")));
  assert.ok(!exists(path.join(home, ".claude.json")));

  const legacyHome = tempHome();
  const legacy = path.join(legacyHome, ".claude", ".config.json");
  fs.mkdirSync(path.dirname(legacy));
  fs.writeFileSync(legacy, "{}");
  await cli(["connect", "claude-code", "--api-key", KEY], { home: legacyHome, bins: ["claude"] });
  assert.equal(readJson(legacy).mcpServers.oceantoken.url, URL);
  assert.ok(!exists(path.join(legacyHome, ".claude.json")));
});

test("claude-code and gemini without a key but with --url still use their own `mcp add`", async () => {
  const custom = "https://mcp.example.test/mcp";
  const claude = await cli(["connect", "claude-code", "--url", custom], { bins: ["claude"] });
  assert.deepEqual(claude.calls.map(cmdline), [
    "claude mcp remove oceantoken --scope user",
    `claude mcp add --transport http --scope user oceantoken ${custom}`,
  ]);
  const gemini = await cli(["connect", "gemini", "--url", custom], { bins: ["gemini"] });
  assert.deepEqual(gemini.calls.map(cmdline), [
    "gemini mcp remove --scope user oceantoken",
    `gemini mcp add --scope user --transport http oceantoken ${custom}`,
  ]);
});

test("gemini: install the extension with consent, or update it when already there", async () => {
  const fresh = await cli(["connect", "gemini"], { bins: ["gemini"] });
  assert.deepEqual(fresh.calls.map(cmdline), [
    "gemini extensions install https://github.com/OceanTokenAI/oceantoken-plugins --consent",
  ]);
  assert.match(fresh.out, /\/mcp auth oceantoken/);

  const home = tempHome();
  fs.mkdirSync(path.join(home, ".gemini", "extensions", "oceantoken"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "extensions", "oceantoken", "gemini-extension.json"), "{}");
  const update = await cli(["connect", "gemini"], { home, bins: ["gemini"] });
  assert.deepEqual(update.calls.map(cmdline), ["gemini extensions update oceantoken"]);
});

test("gemini with a key: the user-scope server goes into ~/.gemini/settings.json, never onto a command line", async () => {
  const home = tempHome();
  const file = path.join(home, ".gemini", "settings.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ general: { vimMode: true }, mcpServers: { oceantoken: { httpUrl: "old" } } }));
  const res = await cli(["connect", "gemini", "--api-key", KEY], { home, bins: ["gemini"] });
  assert.equal(res.code, 0, res.out);
  assertKeyNotInArgv(assert, res);
  assert.equal(res.calls.length, 0, "nothing is run: no extension, no `gemini mcp add`");
  assert.deepEqual(readJson(file), {
    general: { vimMode: true },
    mcpServers: { oceantoken: { httpUrl: URL, headers: { Authorization: `Bearer ${KEY}` } } },
  });
  assert.ok(exists(path.join(home, ".gemini", "skills", "oceantoken-models", "SKILL.md")));
  assert.ok(!res.out.includes(KEY));

  const elsewhere = tempHome();
  await cli(["connect", "gemini", "--api-key", KEY], { home: tempHome(), bins: ["gemini"], env: { GEMINI_CLI_HOME: elsewhere } });
  assert.equal(readJson(path.join(elsewhere, ".gemini", "settings.json")).mcpServers.oceantoken.httpUrl, URL);
});

test("openclaw with a key: the server entry goes to `openclaw config patch` on stdin, not on the command line", async () => {
  const res = await cli(["connect", "openclaw", "--api-key", KEY], { bins: ["openclaw"] });
  assert.equal(res.code, 0, res.out);
  assertKeyNotInArgv(assert, res);
  assert.deepEqual(res.calls.map(cmdline), [
    "openclaw plugins install clawhub:@oceantoken/oceantoken --accept-capabilities",
    "openclaw config patch --stdin --replace-path mcp.servers.oceantoken",
  ]);
  assert.deepEqual(JSON.parse(res.calls[1].input), {
    mcp: { servers: { oceantoken: { url: URL, transport: "streamable-http", headers: { Authorization: `Bearer ${KEY}` } } } },
  });
  assert.ok(!res.out.includes(KEY));
});

test("with a key, no client puts it on a command line or in the output, and every client stores it", async () => {
  const bins = ["codex", "claude", "gemini", "openclaw", "opencode", "hermes", "code", "cursor"];
  for (const client of CLIENTS) {
    for (const extra of [[], ["--url", "https://mcp.example.test/mcp"], ["--dry-run"]]) {
      const home = tempHome();
      const res = await cli(["connect", client.id, "--api-key", KEY, "--no-login", ...extra], { home, bins });
      const label = [client.id, ...extra].join(" ");
      assert.equal(res.code, 0, `${label}: ${res.out}`);
      assertKeyNotInArgv(assert, res, label);
      assert.ok(!res.out.includes(KEY), `${label} printed the key`);
      if (extra.includes("--dry-run")) continue;
      const stored = res.calls.some((c) => c.input?.includes(KEY)) || filesUnder(home).some((f) => read(f).includes(KEY));
      assert.ok(stored, `${label} did not store the key anywhere`);
    }
    // disconnect after a keyed connect runs the hosts' own remove commands: no key there either.
    const home = tempHome();
    await cli(["connect", client.id, "--api-key", KEY, "--no-login"], { home, bins });
    assertKeyNotInArgv(assert, await cli(["disconnect", client.id], { home, bins }), `disconnect ${client.id}`);
  }
});

test("openclaw: ClawHub plugin for the skills, a managed OAuth server, then mcp login", async () => {
  const res = await cli(["connect", "openclaw"], { bins: ["openclaw"] });
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(res.calls.map(cmdline), [
    "openclaw plugins install clawhub:@oceantoken/oceantoken --accept-capabilities",
    `openclaw mcp set oceantoken {"url":"${URL}","transport":"streamable-http","auth":"oauth"}`,
    "openclaw mcp login oceantoken",
  ]);
  assert.equal(res.calls[2].inherit, true);
});

test("opencode: a fresh config gets the schema; a commented one is left for the user", async () => {
  const home = tempHome();
  const res = await cli(["connect", "opencode", "--no-login"], { home });
  const file = path.join(home, ".config", "opencode", "opencode.json");
  assert.deepEqual(readJson(file), {
    $schema: "https://opencode.ai/config.json",
    mcp: { oceantoken: { type: "remote", url: URL, enabled: true } },
  });
  assert.ok(exists(path.join(home, ".config", "opencode", "skills", "oceantoken-media")));
  assert.match(res.out, /opencode mcp auth oceantoken/);

  const home2 = tempHome();
  const jsonc = path.join(home2, ".config", "opencode", "opencode.jsonc");
  fs.mkdirSync(path.dirname(jsonc), { recursive: true });
  fs.writeFileSync(jsonc, "{\n  // mine\n}\n");
  const manual = await cli(["connect", "opencode"], { home: home2 });
  assert.equal(manual.code, 0);
  assert.match(manual.out, /Result {4}incomplete/);
  assert.match(manual.out, /Add this to ~\/\.config\/opencode\/opencode\.jsonc/);
  assert.equal(read(jsonc), "{\n  // mine\n}\n");
});

test("hermes, workbuddy, windsurf and vscode write their own config formats", async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".config", "devin"), { recursive: true });
  for (const client of ["hermes", "workbuddy", "windsurf", "vscode"]) {
    const res = await cli(["connect", client, "--no-login"], { home });
    assert.equal(res.code, 0, `${client}: ${res.out}`);
  }
  assert.match(read(path.join(home, ".hermes", "config.yaml")), /mcp_servers:\n  # OceanToken[^\n]*\n  oceantoken:\n    url: "https:\/\/mcp\.oceantoken\.ai\/mcp"\n    auth: oauth/);
  assert.ok(exists(path.join(home, ".hermes", "skills", "oceantoken-media")));
  assert.deepEqual(readJson(path.join(home, ".workbuddy-ai", "mcp.json")).mcpServers.oceantoken, { type: "streamableHttp", url: URL });
  assert.deepEqual(readJson(path.join(home, ".config", "devin", "mcp_config.json")).mcpServers.oceantoken, { serverUrl: URL });
  const vscodeDir =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Code", "User")
      : path.join(home, ".config", "Code", "User");
  if (process.platform !== "win32") {
    assert.deepEqual(readJson(path.join(vscodeDir, "mcp.json")).servers.oceantoken, { type: "http", url: URL });
  }
  assert.ok(exists(path.join(home, ".copilot", "skills", "oceantoken-models")));
});

test("--dry-run changes nothing and runs nothing", async () => {
  const home = tempHome();
  const res = await cli(["connect", "codex", "--dry-run"], { home, bins: ["codex"] });
  assert.equal(res.calls.length, 0);
  assert.match(res.out, /would run: codex plugin add oceantoken@oceantoken/);
  const files = await cli(["connect", "cursor", "--dry-run"], { home });
  assert.ok(!exists(path.join(home, ".cursor")));
  assert.match(files.out, /would be created/);
});

test("clients lists what is detected", async () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".workbuddy-ai"));
  const res = await cli(["clients"], { home, bins: ["claude"] });
  assert.match(res.out, /claude-code\s+yes/);
  assert.match(res.out, /workbuddy\s+yes/);
  assert.match(res.out, /codex\s+no/);
});
