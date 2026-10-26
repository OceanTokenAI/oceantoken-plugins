import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYS_URL, SIGNUP_URL, keysUrl, signupUrl } from "../src/constants.js";
import { KEY, cli, tempHome } from "./helpers.js";

const CONSOLE_LINK = /https:\/\/app\.oceantoken\.ai\/[^\s)]*/g;

/** Every console link in some output, parsed. */
const consoleLinks = (text) => (text.match(CONSOLE_LINK) ?? []).map((u) => new URL(u));

function assertFromCli(url, tool) {
  assert.ok(url.pathname.startsWith("/ui/"), `${url} stays on a /ui/ path (the bare root drops the query)`);
  assert.equal(url.searchParams.get("src"), "cli", `${url} says it came from the CLI`);
  assert.equal(url.searchParams.get("tool"), tool, `${url} names the client`);
}

test("console links carry src=cli, and tool=<client id> when there is one", () => {
  assert.equal(KEYS_URL, "https://app.oceantoken.ai/ui/?page=api-keys&src=cli");
  assert.equal(SIGNUP_URL, "https://app.oceantoken.ai/ui/signup/?src=cli");
  assert.equal(keysUrl("codex"), "https://app.oceantoken.ai/ui/?page=api-keys&src=cli&tool=codex");
  assert.equal(signupUrl("claude-code"), "https://app.oceantoken.ai/ui/signup/?src=cli&tool=claude-code");
  assert.equal(keysUrl(), KEYS_URL);
  assert.equal(signupUrl(null), SIGNUP_URL);
});

test("use codex opens the keys page with src=cli&tool=codex and prints the sign-up link the same way", async () => {
  const res = await cli(["use", "codex"], { home: tempHome(), promptKey: async () => KEY });
  assert.equal(res.code, 0, res.out + res.err);
  const opened = res.calls.find((c) => c.args.some((a) => String(a).startsWith("https://app.oceantoken.ai")));
  assert.ok(opened, "the keys page is opened in the browser");
  const url = opened.args.at(-1);
  assert.equal(url, "https://app.oceantoken.ai/ui/?page=api-keys&src=cli&tool=codex");
  assertFromCli(new URL(url), "codex");
  assert.ok(res.out.includes("https://app.oceantoken.ai/ui/signup/?src=cli&tool=codex"), res.out);
  const printed = consoleLinks(res.out);
  assert.equal(printed.length, 2, res.out);
  for (const u of printed) assertFromCli(u, "codex");
});

test("help text links carry src=cli without a tool", async () => {
  const res = await cli(["--help"]);
  assert.equal(res.code, 0);
  assert.ok(res.out.includes("API keys: https://app.oceantoken.ai/ui/?page=api-keys&src=cli "), res.out);
  assert.ok(res.out.includes("New account: https://app.oceantoken.ai/ui/signup/?src=cli\n"), res.out);
  const links = consoleLinks(res.out);
  assert.equal(links.length, 2);
  for (const u of links) assertFromCli(u, null);
});

test("connect and use name the client in the keys link of errors and Next steps", async () => {
  const rejected = await cli(["connect", "cursor", "--api-key", KEY], { models: 401 });
  assert.equal(rejected.code, 1);
  assert.ok(rejected.out.includes("Create or copy a key at https://app.oceantoken.ai/ui/?page=api-keys&src=cli&tool=cursor"), rejected.out);

  const badEnv = await cli(["connect", "gemini", "--use-env-key"]);
  assert.equal(badEnv.code, 2);
  assert.ok(badEnv.err.includes("Create a key at https://app.oceantoken.ai/ui/?page=api-keys&src=cli&tool=gemini"), badEnv.err);

  const useRejected = await cli(["use", "claude-code", "--api-key", KEY], { models: 401 });
  assert.equal(useRejected.code, 1);
  for (const u of consoleLinks(useRejected.out)) assertFromCli(u, "claude-code");
  assert.ok(useRejected.out.includes("tool=claude-code"), useRejected.out);

  const noKey = await cli(["use", "codex"]);
  assert.equal(noKey.code, 2);
  assert.ok(noKey.err.includes("Create a key at https://app.oceantoken.ai/ui/?page=api-keys&src=cli&tool=codex"), noKey.err);
});
