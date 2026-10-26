import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { HELP, OPTIONS } from "../src/cli.js";
import { CLIENTS } from "../src/clients/index.js";
import { DEFAULT_MCP_URL, DOCS_URL } from "../src/constants.js";

// QA-094: the README in the npm package, the npm description, the repo README and INSTALL.md
// (served at https://mcp.oceantoken.ai/install) must describe the same CLI.

const repoFile = (name) => fs.readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
const cliReadme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** "VS Code (GitHub Copilot)" -> "VS Code", "Windsurf / Devin Desktop" -> "Windsurf". */
const shortName = (c) => c.label.split(/ \(| \//)[0];
const USE_CLIENTS = CLIENTS.filter((c) => c.use).map((c) => c.id);

const optionLines = (text) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(-\w, )?--[a-z]/.test(l));

test("the README's Options section lists exactly the flags of --help, worded the same", () => {
  const block = cliReadme.split("## Options")[1].split("```text\n")[1].split("```")[0];
  assert.deepEqual(optionLines(block), optionLines(HELP.replaceAll(DEFAULT_MCP_URL, "https://mcp.oceantoken.ai/mcp")));
  // connect and use share some flags, and one line can name two ("--dry-run, --json").
  const documented = new Set(optionLines(HELP).flatMap((l) => [...l.split(/\s{2,}/)[0].matchAll(/--([a-z-]+)/g)].map((m) => m[1])));
  assert.deepEqual([...documented].sort(), Object.keys(OPTIONS).sort(), "--help documents every flag the parser accepts");
  for (const [name, { short }] of Object.entries(OPTIONS)) {
    if (short) assert.ok(optionLines(HELP).some((l) => l.startsWith(`-${short}, --${name}`)), `--help lists -${short}`);
  }
});

test("the README, the npm description, the repo README and INSTALL.md name every supported client", () => {
  const connectPart = cliReadme.split("## Run Codex or Claude Code")[0];
  const rows = connectPart.split("\n").filter((l) => /^\| .* \| `[a-z-]+` \|/.test(l));
  assert.deepEqual(
    rows.map((l) => l.match(/\| `([a-z-]+)` \|/)[1]),
    CLIENTS.map((c) => c.id),
    "the CLI README's client table",
  );
  assert.match(cliReadme, new RegExp(`supports ${NUMBERS[CLIENTS.length]} clients`));
  const rootReadme = repoFile("README.md");
  const install = repoFile("INSTALL.md");
  for (const c of CLIENTS) {
    assert.ok(pkg.description.includes(shortName(c)), `npm description lacks ${shortName(c)}`);
    assert.ok(rootReadme.split("## What your agent gets")[0].includes(shortName(c)), `repo README intro lacks ${shortName(c)}`);
    assert.ok(rootReadme.includes(`\`${c.id}\``), `repo README's client list lacks ${c.id}`);
    assert.ok(install.includes(`connect ${c.id} `), `INSTALL.md lacks connect ${c.id}`);
  }
});

test("--help, the README and the npm description name the agents `use` can switch", () => {
  assert.ok(HELP.includes(`use <${USE_CLIENTS.join("|")}>`), "--help usage");
  assert.ok(HELP.includes(`unuse <${USE_CLIENTS.join("|")}>`), "--help usage");
  const usePart = cliReadme.split("## Run Codex or Claude Code")[1].split("\n## ")[0];
  for (const id of USE_CLIENTS) {
    assert.ok(usePart.includes(`use ${id}`), `README shows use ${id}`);
    const c = CLIENTS.find((x) => x.id === id);
    assert.ok(usePart.includes(`| ${c.label} |`), `README's use table has ${c.label}`);
    assert.ok(pkg.description.includes(c.label), `npm description names ${c.label} for use`);
  }
});

/** A console page, without the tracking parameters (utm_*, src, tool) links may carry. */
function consolePage(url) {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "src" || key === "tool") u.searchParams.delete(key);
  }
  return u.toString();
}
const KEYS_PAGE = "https://app.oceantoken.ai/ui/?page=api-keys";
const SIGNUP_PAGE = "https://app.oceantoken.ai/ui/signup/";

test("docs link to the current key, sign-up, models and guide pages", () => {
  const docs = {
    "cli/README.md": cliReadme,
    "README.md": repoFile("README.md"),
    "INSTALL.md": repoFile("INSTALL.md"),
    "GEMINI.md": repoFile("GEMINI.md"),
    "plugins/oceantoken/README.md": repoFile("plugins/oceantoken/README.md"),
    "--help": HELP,
    ...Object.fromEntries(
      ["oceantoken-media", "oceantoken-models", "oceantoken-setup"].map((s) => [s, repoFile(`plugins/oceantoken/skills/${s}/SKILL.md`)]),
    ),
  };
  for (const [name, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /model_hub/, `${name} links the old console model hub; use https://oceantoken.ai/models`);
    for (const url of text.match(/https:\/\/app\.oceantoken\.ai\/ui\/[^\s)"'>`]*/g) ?? []) {
      assert.ok([KEYS_PAGE, SIGNUP_PAGE].includes(consolePage(url)), `${name}: ${url} is neither the keys page nor the sign-up page`);
    }
  }
  assert.ok(HELP.includes(DOCS_URL) && cliReadme.includes(DOCS_URL), "--help and the README link the guide");
  assert.ok((cliReadme.match(/https:\/\/app\.oceantoken\.ai\/ui\/[^\s)"'>`]*/g) ?? []).some((u) => consolePage(u) === KEYS_PAGE));
  assert.match(HELP, /never passed to another program on its command line/);
});
