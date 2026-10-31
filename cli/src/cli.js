import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { CLIENTS, findClient } from "./clients/index.js";
import { API_BASE, DEFAULT_MCP_URL, DOCS_URL, KEY_ENV, KEYS_URL, SIGNUP_URL, keysUrl, signupUrl } from "./constants.js";
import { createContext } from "./context.js";
import { apiBaseFor, mcpUrlFor, resolveApiKey, serverReachable, verifyApiKey } from "./lib/apikey.js";
import { openUrl, promptHidden, promptYesNo } from "./lib/prompt.js";
import { redact, run as realRun } from "./lib/run.js";
import { forgetKey, keepKey, keptKey, keptKeyFile } from "./lib/kept-keys.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json");

/** Every flag the CLI accepts. HELP and the README's Options section list each one (a test checks). */
export const OPTIONS = {
  "api-key": { type: "string" },
  "use-env-key": { type: "boolean", default: false },
  "no-login": { type: "boolean", default: false },
  "no-skills": { type: "boolean", default: false },
  "no-tools": { type: "boolean", default: false },
  "move-chats": { type: "boolean", default: false },
  "forget-key": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  url: { type: "string" },
  model: { type: "string" },
  "api-base": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
};

export const HELP = `OceanToken CLI ${VERSION}: connect your AI agent to OceanToken (500+ AI models, one account).

Usage
  npx -y @oceantoken/cli@latest connect <client> [options]
  npx -y @oceantoken/cli@latest disconnect <client>
  npx -y @oceantoken/cli@latest clients
  npx -y @oceantoken/cli@latest use <codex|claude-code> [--model <id>]
  npx -y @oceantoken/cli@latest unuse <codex|claude-code> [--forget-key]
  npx -y @oceantoken/cli@latest status

connect adds OceanToken's tools (image, video, speech, 500+ models) to your agent.
use makes OceanToken the model provider the agent itself runs on, billed to your
OceanToken balance (for Codex it also adds the tools); unuse puts the previous setup back
(your ChatGPT or Claude plan). The key is kept, so use again switches back without
pasting it. status shows what each agent runs on now.

Clients
${CLIENTS.map((c) => `  ${c.id.padEnd(12)} ${c.label}`).join("\n")}

Options for connect
  --api-key <key|->   Use an API key instead of OAuth sign-in ("-" reads it from stdin)
  --use-env-key       Use the key in OCEANTOKEN_API_KEY
  --no-login          Configure only; do not start the sign-in
  --no-skills         Do not install the OceanToken skills
  --dry-run           Show what would change without changing anything
  --json              Print the report as JSON
  --url <mcp-url>     MCP endpoint (default ${DEFAULT_MCP_URL})

Options for use
  --api-key <key|->   The OceanToken API key (asked for when omitted)
  --use-env-key       Have the agent read the key from ${KEY_ENV} instead of storing it
  --model <id>        Model to run on, e.g. deepseek/deepseek-v4-pro (default: GPT-5.5
                      for Codex; Claude's own Opus/Sonnet/Haiku for Claude Code)
  --api-base <url>    OceanToken API (default ${API_BASE})
  --move-chats        Codex: also move your existing chats to OceanToken (with unuse:
                      back to your ChatGPT plan). Quit Codex first; a backup is made
  --no-tools          Codex: do not add OceanToken's image/video/speech tools and skills
  --url, --no-skills, --dry-run, --json   As for connect

Options for unuse
  --forget-key        Also delete the API key use kept for switching back

Other options
  -h, --help          Show this help
  -v, --version       Print the CLI version

Sign-in uses OAuth by default: the client opens the OceanToken sign-in page.
An API key is never passed to another program on its command line and never printed.
API keys: ${KEYS_URL}   New account: ${SIGNUP_URL}
Docs: ${DOCS_URL}
`;

function parse(argv) {
  return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
}

function detectedClients(base) {
  return CLIENTS.filter((c) => {
    try {
      return c.detect(createContext({ client: c, ...base, quiet: true }));
    } catch {
      return false;
    }
  });
}

function summarize(report, print) {
  const failed = report.steps.some((s) => s.status === "failed");
  const manual = report.steps.some((s) => s.status === "manual");
  report.result = failed ? "failed" : manual || report.signIn === "failed" ? "incomplete" : "connected";
  if (report.dryRun) report.result = failed ? "failed" : "dry run";
  const rows = [
    ["Client", report.label],
    ["Auth", report.auth === "api-key" ? "API key" : "OAuth sign-in"],
    ["MCP", report.mcp ?? "not configured"],
    ["Skills", report.skills ?? "not installed"],
    ["Sign-in", report.signIn ?? "–"],
    ["Restart", report.restart ?? "–"],
    ["Result", report.result],
  ];
  print("");
  print("Summary");
  for (const [k, v] of rows) print(`  ${k.padEnd(9)} ${v}`);
  if (report.next.length) {
    print("");
    print("Next");
    for (const n of report.next) print(`  - ${n.replace(/\n/g, "\n    ")}`);
  }
}

/** Returns the process exit code. `deps` lets tests swap the environment and side effects. */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const print = deps.print ?? ((line) => process.stdout.write(`${line}\n`));
  const printErr = deps.printErr ?? ((line) => process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const base = {
    home: deps.home ?? os.homedir(),
    env,
    runner: deps.runner,
    whichImpl: deps.whichImpl,
    print,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];

  let args;
  try {
    args = parse(argv);
  } catch (err) {
    printErr(`${err.message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.version) {
    print(VERSION);
    return 0;
  }
  const [command, clientName] = positionals;
  if (values.help || !command || command === "help") {
    print(HELP);
    return command || values.help ? 0 : 2;
  }

  if (command === "clients" || command === "list") {
    const found = new Set(detectedClients(base).map((c) => c.id));
    print("Client        Detected  Name");
    for (const c of CLIENTS) print(`${c.id.padEnd(13)} ${found.has(c.id) ? "yes     " : "no      "}  ${c.label}`);
    return 0;
  }

  if (command === "use" || command === "unuse") {
    return switchProvider(command, clientName, values, { base, deps, print, printErr, env });
  }

  if (command === "status") {
    const ctx = { env, home: base.home, path: (...p) => path.join(base.home, ...p) };
    const rows = CLIENTS.filter((c) => c.runsOn).map((c) => ({ agent: c.id, label: c.label, ...c.runsOn(ctx), keyKept: Boolean(keptKey(base.home, c.id)) }));
    if (values.json) {
      print(JSON.stringify(rows, null, 2));
      return 0;
    }
    print("What each agent runs on");
    for (const r of rows) print(`  ${r.agent.padEnd(12)} ${r.oceantoken ? "OceanToken" : "not OceanToken"} - ${r.detail}`);
    print("");
    print("Switch: npx -y @oceantoken/cli@latest use <agent>   Back: npx -y @oceantoken/cli@latest unuse <agent>");
    print("Then start a new session of the agent (VS Code or Cursor: run Developer: Reload Window).");
    return 0;
  }

  if (command !== "connect" && command !== "disconnect") {
    printErr(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }
  const client = findClient(clientName);
  if (!client) {
    const found = detectedClients(base).map((c) => c.id);
    printErr(
      `${clientName ? `Unknown client "${clientName}".` : "Say which client to connect."} Supported: ${CLIENTS.map((c) => c.id).join(", ")}.` +
        (found.length ? `\nDetected on this machine: ${found.join(", ")}.` : ""),
    );
    return 2;
  }

  let apiKey = null;
  if (command === "connect") {
    try {
      apiKey = await resolveApiKey({ flag: values["api-key"], useEnv: values["use-env-key"], env });
    } catch (err) {
      printErr(`Error: ${err.message}. Create a key at ${keysUrl(client.id)}`);
      return 2;
    }
  }

  const quietSteps = values.json;
  const ctx = createContext({
    client,
    ...base,
    mcpUrl: values.url ?? DEFAULT_MCP_URL,
    apiKey,
    dryRun: values["dry-run"],
    login: !values["no-login"],
    skills: !values["no-skills"],
    quiet: quietSteps,
  });
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  if (!quietSteps) print(`OceanToken → ${client.label}${ctx.dryRun ? " (dry run)" : ""}`);
  try {
    if (command === "connect") {
      if (await serverReachable(ctx.mcpUrl, { fetchImpl })) ctx.step("Server", "ok", ctx.mcpUrl);
      else ctx.step("Server", "manual", `${ctx.mcpUrl} did not answer; continuing`);
      const apiBase = apiKey ? apiBaseFor(ctx.mcpUrl) : null;
      if (apiKey && !apiBase) {
        ctx.step("API key", "manual", `not checked: ${ctx.mcpUrl} has no matching OceanToken API; continuing`);
      } else if (apiKey) {
        const verdict = await verifyApiKey(apiKey, { apiBase, fetchImpl });
        if (verdict === "rejected") {
          ctx.step("API key", "failed", `rejected by ${apiBase === API_BASE ? "OceanToken" : new URL(apiBase).host} (wrong, revoked or expired)`);
          ctx.next(`Create or copy a key at ${keysUrl(client.id)} and run this again.`);
        } else {
          ctx.step("API key", verdict === "valid" ? "ok" : "manual", verdict === "valid" ? "accepted" : "could not be checked; continuing");
        }
      }
      if (!ctx.report.steps.some((s) => s.status === "failed")) await client.connect(ctx);
    } else {
      await client.disconnect(ctx);
      ctx.report.result = ctx.report.steps.some((s) => s.status === "failed") ? "failed" : "disconnected";
    }
  } catch (err) {
    ctx.step("Error", "failed", redact(err?.message ?? String(err), apiKey ? [apiKey] : []));
  }

  ctx.finalize();
  if (command === "connect") {
    if (quietSteps) summarize(ctx.report, () => {});
    else summarize(ctx.report, print);
  } else if (!quietSteps) {
    print(`\nResult    ${ctx.report.result}`);
    for (const n of ctx.report.next) print(`  - ${n}`);
  }
  if (values.json) print(JSON.stringify(ctx.report, null, 2));
  return ctx.report.steps.some((s) => s.status === "failed") ? 1 : 0;
}

const USE_CLIENTS = () => CLIENTS.filter((c) => c.use).map((c) => c.id);

/** The key for `use`: a flag, the environment, the key an earlier `use` stored, or pasted. */
async function keyForUse(client, values, { base, env, deps, print }) {
  const fromFlags = await resolveApiKey({ flag: values["api-key"], useEnv: values["use-env-key"], env });
  if (fromFlags) return { key: fromFlags, kept: false };
  const saved = client.savedKey?.({ env, path: (...p) => path.join(base.home, ...p) });
  if (saved) {
    print("Using the API key an earlier `use` saved in the config.");
    return { key: saved, kept: false };
  }
  const kept = keptKey(base.home, client.id);
  if (kept) {
    print(`Using the API key kept from your last \`use ${client.id}\` (unuse ${client.id} --forget-key deletes it).`);
    return { key: kept, kept: true };
  }
  const interactive = deps.promptKey ?? (process.stdin.isTTY && process.stdout.isTTY ? promptHidden : null);
  if (!interactive) {
    throw new Error(`no API key. Pass --api-key - (reads stdin) or --use-env-key with ${KEY_ENV} set`);
  }
  const keys = keysUrl(client.id);
  print(`Opening ${keys} - create a key there (no account yet? ${signupUrl(client.id)}).`);
  await openUrl(keys, deps.runner ?? realRun);
  return { key: await resolveApiKey({ flag: await interactive("Paste your OceanToken API key (sk-...): ") }), kept: false };
}

async function switchProvider(command, clientName, values, { base, deps, print, printErr, env }) {
  const client = findClient(clientName);
  if (!client?.use) {
    printErr(`${clientName ? `"${clientName}" cannot be switched.` : "Say which agent to switch."} Supported: ${USE_CLIENTS().join(", ")}.`);
    return 2;
  }
  let apiKey = null;
  let fromKept = false;
  if (command === "use") {
    try {
      ({ key: apiKey, kept: fromKept } = await keyForUse(client, values, { base, env, deps, print }));
    } catch (err) {
      printErr(`Error: ${err.message}. Create a key at ${keysUrl(client.id)}`);
      return 2;
    }
  }
  const quiet = values.json;
  const apiBase = (values["api-base"] ?? API_BASE).replace(/\/+$/, "");
  const interactive = !quiet && !values["dry-run"] && process.stdin.isTTY && process.stdout.isTTY;
  const ctx = createContext({
    client,
    ...base,
    apiBase,
    // The tools that go with this API: the default pair, mcp.<domain> for api.<domain>, or --url.
    mcpUrl: values.url ?? (apiBase === API_BASE ? DEFAULT_MCP_URL : mcpUrlFor(apiBase)),
    apiKey,
    useEnvKey: values["use-env-key"],
    model: values.model ?? null,
    dryRun: values["dry-run"],
    skills: !values["no-skills"],
    tools: !values["no-tools"],
    moveChats: values["move-chats"],
    confirm: deps.confirm ?? (interactive ? promptYesNo : null),
    appEngines: deps.appEngines,
    quiet,
  });
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!quiet) print(`OceanToken ${command === "use" ? "→" : "✕"} ${client.label} models${ctx.dryRun ? " (dry run)" : ""}`);
  try {
    if (command === "use") {
      const verdict = await verifyApiKey(apiKey, { apiBase: ctx.apiBase, fetchImpl });
      if (verdict === "rejected") {
        ctx.step("API key", "failed", "rejected by OceanToken (wrong, revoked or expired)");
        // A kept key that stopped working is not offered again.
        if (fromKept && !ctx.dryRun) forgetKey(base.home, client.id);
        ctx.next(`Create or copy a key at ${keysUrl(client.id)} and run this again.`);
      } else {
        ctx.step("API key", verdict === "valid" ? "ok" : "manual", verdict === "valid" ? "accepted" : "could not be checked; continuing");
        await client.use(ctx, { fetchImpl });
        // Kept for switching back after unuse; not with --use-env-key (the key stays in the environment).
        if (!ctx.dryRun && !values["use-env-key"] && !ctx.report.steps.some((s) => s.status === "failed")) keepKey(base.home, client.id, apiKey);
      }
    } else {
      await client.unuse(ctx, { fetchImpl });
      if (values["forget-key"] && !ctx.dryRun) ctx.report.keyKept = forgetKey(base.home, client.id) ? "deleted" : "none kept";
      else ctx.report.keyKept = keptKey(base.home, client.id) ? `kept in ${keptKeyFile(base.home)}` : "none kept";
    }
  } catch (err) {
    ctx.step("Error", "failed", redact(err?.message ?? String(err), apiKey ? [apiKey] : []));
  }
  const report = ctx.finalize();
  const failed = report.steps.some((s) => s.status === "failed");
  const manual = report.steps.some((s) => s.status === "manual" && s.name !== "API key");
  if (command === "use") report.result = failed ? "failed" : report.dryRun ? "dry run" : manual ? "incomplete" : "switched";
  else report.result = failed ? "failed" : report.dryRun ? "dry run" : "restored";
  if (!quiet) {
    const rows =
      command === "use"
        ? [
            ["Agent", report.label],
            ["Provider", report.provider ?? "–"],
            ["Model", report.model ?? "–"],
            ["Key", report.authIn ?? "–"],
            ...(client.id === "codex" ? [["Tools", report.mcp ?? "not added"], ["Chats", report.chats ?? "not moved"]] : []),
            ["Backup", report.backup ?? "–"],
            ["Restart", report.restart ?? "–"],
            ["Undo", `npx -y @oceantoken/cli@latest unuse ${client.id}`],
            ["Result", report.result],
          ]
        : [
            ["Agent", report.label],
            ...(client.id === "codex" ? [["Chats", report.chats ?? "not moved"]] : []),
            ...(report.backup ? [["Backup", report.backup]] : []),
            ["Restart", report.restart ?? "–"],
            ["Key", report.keyKept ?? "–"],
            ["Back", `npx -y @oceantoken/cli@latest use ${client.id}`],
            ["Result", report.result],
          ];
    print("");
    print("Summary");
    for (const [k, v] of rows) print(`  ${k.padEnd(9)} ${v}`);
    if (report.next.length) {
      print("");
      print("Next");
      for (const n of report.next) print(`  - ${n.replace(/\n/g, "\n    ")}`);
    }
  } else {
    print(JSON.stringify(report, null, 2));
  }
  return failed ? 1 : 0;
}
