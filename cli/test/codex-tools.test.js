import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MEDIA_NOTE } from "../src/clients/codex-use.js";
import { KEY, cli, exists, read, readJson, tempHome } from "./helpers.js";

// `use codex` also connects OceanToken's tools: on OceanToken, Codex has no built-in image
// tool, and without these an image request fails or goes to a third-party app.

const USER_TOML = 'model = "gpt-5.5"\n\n[mcp_servers.github]\nurl = "https://g"\n';
const codexDir = (home) => path.join(home, ".codex");
const configOf = (home) => path.join(codexDir(home), "config.toml");
const skillsOf = (home) => path.join(home, ".agents", "skills");

function homeWith(files = {}) {
  const home = tempHome();
  fs.mkdirSync(codexDir(home));
  fs.writeFileSync(configOf(home), USER_TOML);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  }
  return home;
}

test("use codex adds the tools server with the same key, the skills and the instructions note; unuse removes exactly them", async () => {
  const home = homeWith({ ".codex/AGENTS.md": "# My rules\n\nBe brief.\n" });
  const res = await cli(["use", "codex", "--api-key", KEY], { home });
  assert.equal(res.code, 0, res.out);
  const toml = read(configOf(home));
  assert.match(toml, /\[mcp_servers\.oceantoken\]\nurl = "https:\/\/mcp\.oceantoken\.ai\/mcp"\nhttp_headers = \{ "Authorization" = "Bearer sk-/);
  for (const s of ["oceantoken-media", "oceantoken-models", "oceantoken-setup"]) {
    assert.ok(exists(path.join(skillsOf(home), s, "SKILL.md")), s);
  }
  const agents = read(path.join(codexDir(home), "AGENTS.md"));
  assert.ok(agents.startsWith("# My rules\n\nBe brief.\n\n<!-- OceanToken"), "the user's own instructions come first, untouched");
  assert.ok(agents.includes(MEDIA_NOTE));
  assert.match(MEDIA_NOTE, /generate_image/);
  assert.match(MEDIA_NOTE, /built-in image_gen/);
  assert.match(res.out, /Tools {5}oceantoken in ~\/\.codex\/config\.toml/);
  assert.ok(!res.out.includes(KEY));
  assert.equal(readJson(path.join(home, ".oceantoken", "cli-state.json")).codex.tools.mcp, "added");

  const again = await cli(["use", "codex", "--api-key", KEY], { home });
  assert.equal(again.code, 0, again.out);
  assert.equal((read(configOf(home)).match(/\[mcp_servers\.oceantoken\]/g) || []).length, 1, "a rerun adds nothing twice");
  assert.equal((read(path.join(codexDir(home), "AGENTS.md")).match(/<!-- OceanToken/g) || []).length, 1);

  const back = await cli(["unuse", "codex"], { home });
  assert.equal(back.code, 0, back.out);
  assert.equal(read(configOf(home)), USER_TOML);
  assert.equal(read(path.join(codexDir(home), "AGENTS.md")), "# My rules\n\nBe brief.\n");
  assert.ok(!exists(path.join(skillsOf(home), "oceantoken-media")));
  assert.equal(readJson(path.join(home, ".oceantoken", "cli-state.json")).codex.tools, undefined);
});

test("use codex --dry-run shows the tools, skills and note it would add and changes nothing", async () => {
  const home = homeWith();
  const res = await cli(["use", "codex", "--api-key", KEY, "--dry-run"], { home });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /MCP server .*config\.toml \(would be added\)/);
  assert.match(res.out, /Skills .*3 in ~\/\.agents\/skills/);
  assert.match(res.out, /Instructions .*AGENTS\.md \(would be created\)/);
  assert.equal(read(configOf(home)), USER_TOML);
  assert.ok(!exists(skillsOf(home)));
  assert.ok(!exists(path.join(codexDir(home), "AGENTS.md")));
  assert.ok(!exists(path.join(home, ".oceantoken")));
});

test("an AGENTS.md that use created is deleted again; --use-env-key keeps the key out of the tools entry too", async () => {
  const home = homeWith();
  const res = await cli(["use", "codex", "--use-env-key"], { home, env: { OCEANTOKEN_API_KEY: KEY } });
  assert.equal(res.code, 0, res.out);
  const toml = read(configOf(home));
  assert.match(toml, /\[mcp_servers\.oceantoken\]\nurl = "https:\/\/mcp\.oceantoken\.ai\/mcp"\nbearer_token_env_var = "OCEANTOKEN_API_KEY"/);
  assert.ok(!toml.includes(KEY));
  assert.ok(exists(path.join(codexDir(home), "AGENTS.md")));
  await cli(["unuse", "codex"], { home });
  assert.ok(!exists(path.join(codexDir(home), "AGENTS.md")), "use created it, unuse removes it");
  assert.equal(read(configOf(home)), USER_TOML);
});

test("what connect set up stays after unuse: its server entry, its skills and its plugin", async () => {
  // connect --api-key first: a server entry and skills that belong to connect.
  const home = homeWith();
  assert.equal((await cli(["connect", "codex", "--api-key", KEY], { home, bins: ["codex"] })).code, 0);
  const connected = read(configOf(home));
  await cli(["use", "codex", "--api-key", KEY], { home });
  await cli(["unuse", "codex"], { home });
  assert.equal(read(configOf(home)), connected, "connect's server entry is still there");
  assert.ok(exists(path.join(skillsOf(home), "oceantoken-media", "SKILL.md")), "connect's skills are still there");

  // The plugin (OAuth connect): no second server, the note still goes in.
  const plugged = homeWith();
  fs.appendFileSync(configOf(plugged), '\n[plugins."oceantoken@oceantoken"]\nenabled = true\n');
  const res = await cli(["use", "codex", "--api-key", KEY], { home: plugged });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Tools .*already connected through the oceantoken@oceantoken plugin/);
  assert.doesNotMatch(read(configOf(plugged)), /\[mcp_servers\.oceantoken\]/);
  assert.ok(!exists(skillsOf(plugged)));
  assert.ok(read(path.join(codexDir(plugged), "AGENTS.md")).includes(MEDIA_NOTE));
});

test("--no-tools adds only the provider; the note follows AGENTS.override.md; a rerun reuses the saved key", async () => {
  const home = homeWith();
  const res = await cli(["use", "codex", "--api-key", KEY, "--no-tools"], { home });
  assert.equal(res.code, 0, res.out);
  assert.doesNotMatch(read(configOf(home)), /mcp_servers\.oceantoken/);
  assert.ok(!exists(skillsOf(home)));
  assert.ok(!exists(path.join(codexDir(home), "AGENTS.md")));

  // Codex reads AGENTS.override.md instead of AGENTS.md when it has content.
  fs.writeFileSync(path.join(codexDir(home), "AGENTS.override.md"), "Team rules.\n");
  const rerun = await cli(["use", "codex"], { home });
  assert.equal(rerun.code, 0, `${rerun.out}${rerun.err}`);
  assert.match(rerun.out, /Using the API key an earlier `use` saved/);
  assert.ok(read(path.join(codexDir(home), "AGENTS.override.md")).includes(MEDIA_NOTE));
  assert.ok(!exists(path.join(codexDir(home), "AGENTS.md")));
  assert.match(read(configOf(home)), /\[mcp_servers\.oceantoken\]/);
  await cli(["unuse", "codex"], { home });
  assert.equal(read(path.join(codexDir(home), "AGENTS.override.md")), "Team rules.\n");
});

test("the tools server goes with the API: mcp.<domain> for api.<domain>, --url, or none for a bare host", async () => {
  const dev = homeWith();
  await cli(["use", "codex", "--api-key", KEY, "--api-base", "https://api.dev.example.com"], { home: dev });
  assert.match(read(configOf(dev)), /url = "https:\/\/mcp\.dev\.example\.com\/mcp"/);

  const local = homeWith();
  await cli(["use", "codex", "--api-key", KEY, "--api-base", "http://127.0.0.1:4000", "--url", "http://127.0.0.1:8765/mcp"], { home: local });
  assert.match(read(configOf(local)), /url = "http:\/\/127\.0\.0\.1:8765\/mcp"/);

  const bare = homeWith();
  const res = await cli(["use", "codex", "--api-key", KEY, "--api-base", "http://127.0.0.1:4000"], { home: bare });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Tools .*pass --url <mcp-url>/);
  assert.doesNotMatch(read(configOf(bare)), /mcp_servers\.oceantoken/);
});

test("unuse removes the tools server even after the ChatGPT app dropped its end marker", async () => {
  const home = homeWith();
  await cli(["use", "codex", "--api-key", KEY], { home });
  // The app rewrites config.toml and appends its own tables; the end comments go missing.
  const rewritten = read(configOf(home)).replace(/# end OceanToken\n/, "").replace(/# end OceanToken model provider\n/, "") + '\n[desktop]\nlocaleOverride = "en-US"\n';
  fs.writeFileSync(configOf(home), rewritten);
  const back = await cli(["unuse", "codex"], { home });
  assert.equal(back.code, 0, back.out);
  assert.equal(read(configOf(home)), `${USER_TOML}\n[desktop]\nlocaleOverride = "en-US"\n`);
});

// Codex's model picker lists its catalog's models; `use` gives it OceanToken's ids.
const BUNDLED = {
  models: [
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", shell_type: "unified_exec", context_window: 400000 },
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", shell_type: "unified_exec" },
    { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Auto review", visibility: "hide" },
  ],
};
const catalogRun = (cmd, args) =>
  args.join(" ") === "debug models --bundled" ? { code: 0, stdout: JSON.stringify(BUNDLED), stderr: "" } : { code: 0, stdout: "", stderr: "" };

test("use codex gives the model picker OceanToken's ids, from this Codex's own catalog; unuse takes it away", async () => {
  const home = homeWith();
  fs.appendFileSync(configOf(home), "");
  const before = read(configOf(home));
  const res = await cli(["use", "codex", "--api-key", KEY], {
    home,
    bins: ["codex"],
    respond: catalogRun,
    models: ["openai/gpt-6-luna", "openai/gpt-5.5"],
  });
  assert.equal(res.code, 0, res.out);
  const file = path.join(codexDir(home), "oceantoken-models.json");
  const catalog = readJson(file);
  const listed = catalog.models.filter((m) => m.visibility === "list");
  assert.deepEqual(listed.map((m) => m.slug), ["openai/gpt-6-luna", "openai/gpt-5.5"], "only what OceanToken offers");
  assert.equal(listed[0].context_window, 400000, "each model keeps Codex's settings for it");
  assert.ok(catalog.models.some((m) => m.slug === "gpt-6-luna" && m.visibility === "hide"), "chats still on ChatGPT keep their model's settings");
  assert.match(read(configOf(home)), new RegExp(`model_provider = "oceantoken"\\nmodel = "openai/gpt-5\\.5"\\nmodel_catalog_json = ".*oceantoken-models\\.json"\\n# end OceanToken model provider`));
  assert.match(res.out, /Model list .*lists 2: openai\/gpt-6-luna, openai\/gpt-5\.5/);
  const probe = res.calls.find((c) => c.args.join(" ") === "debug models --bundled");
  assert.ok(probe, "the list comes from the user's own codex");

  const back = await cli(["unuse", "codex"], { home });
  assert.equal(back.code, 0, back.out);
  assert.equal(read(configOf(home)), before);
  assert.ok(!exists(file), "the list goes, after config.toml stopped naming it");
});

test("no model list when Codex's catalog cannot be read; the user's own model_catalog_json is parked and restored", async () => {
  const home = homeWith();
  const res = await cli(["use", "codex", "--api-key", KEY], { home, bins: ["codex"], respond: () => ({ code: 2, stdout: "", stderr: "unknown command" }) });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Model list .*could not be read/);
  assert.doesNotMatch(read(configOf(home)), /model_catalog_json/);

  const own = homeWith();
  fs.writeFileSync(configOf(own), `model_catalog_json = "/mine.json"\n${USER_TOML}`);
  await cli(["use", "codex", "--api-key", KEY], { home: own, bins: ["codex"], respond: catalogRun, models: ["openai/gpt-6-luna"] });
  const toml = read(configOf(own));
  assert.match(toml, /# disabled by @oceantoken\/cli: model_catalog_json = "\/mine\.json"/);
  assert.equal((toml.match(/^model_catalog_json = /gm) || []).length, 1, "TOML gets one key");
  await cli(["unuse", "codex"], { home: own });
  assert.equal(read(configOf(own)), `model_catalog_json = "/mine.json"\n${USER_TOML}`);
});
