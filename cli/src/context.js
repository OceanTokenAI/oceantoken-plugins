import path from "node:path";
import { API_BASE, DEFAULT_MCP_URL } from "./constants.js";
import { readIfExists, writeFileSafely } from "./lib/fsutil.js";
import { removeJsonEntry, upsertJsonEntry } from "./lib/json-config.js";
import { redact, run as realRun, which as realWhich } from "./lib/run.js";
import { installSkills, removeSkills } from "./lib/skills.js";

const MARKS = { ok: "✓", skipped: "–", manual: "!", failed: "✗", pending: "…" };

/**
 * Everything a client module needs: where things live, what the user asked for, and
 * helpers that do one step each and record it in the report. A client module never
 * prints or touches the filesystem except through these.
 */
export function createContext({
  client,
  home,
  env = process.env,
  mcpUrl = DEFAULT_MCP_URL,
  apiBase = API_BASE,
  apiKey = null,
  useEnvKey = false,
  model = null,
  dryRun = false,
  login = true,
  skills = true,
  tools = true,
  moveChats = false,
  confirm = null,
  appEngines,
  quiet = false,
  runner = realRun,
  whichImpl = realWhich,
  print = (line) => process.stdout.write(`${line}\n`),
}) {
  const secrets = apiKey ? [apiKey] : [];
  const report = {
    client: client.id,
    label: client.label,
    auth: apiKey ? "api-key" : "oauth",
    mcpUrl,
    dryRun,
    steps: [],
    provider: null,
    model: null,
    authIn: null,
    backup: null,
    mcp: null,
    skills: null,
    instructions: null,
    chats: null,
    signIn: null,
    restart: null,
    next: [],
  };

  // QA-093: an argument shows in `ps` to every user of the machine, so a step that would put
  // the key on a command line fails before anything runs instead of leaking it.
  const refuseKeyInArgv = (cmd, args) => {
    if (secrets.some((s) => [cmd, ...args].some((a) => String(a).includes(s)))) {
      throw new Error(`refusing to pass the API key to ${cmd} on its command line`);
    }
  };

  // Paths read better as ~/...; secrets never leave this object unredacted.
  const clean = (text) => redact(String(text), secrets).split(home).join("~");
  const say = (line) => {
    if (!quiet) print(clean(line));
  };

  const ctx = {
    client,
    home,
    env,
    mcpUrl,
    apiBase,
    apiKey,
    useEnvKey,
    model,
    dryRun,
    login,
    skills,
    tools,
    moveChats,
    /** Ask the user a yes/no question on the terminal; null when there is no terminal. */
    confirm,
    /** Where desktop apps keep their Codex engine (tests replace it). */
    appEngines,
    report,
    /** The host's own plugin/extension can be used: OAuth against the production server. */
    native: !apiKey && mcpUrl === DEFAULT_MCP_URL,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,

    path: (...parts) => path.join(home, ...parts),
    which: (cmd) => whichImpl(cmd, env),

    step(name, status, detail = "") {
      report.steps.push({ name, status, detail: clean(detail) });
      say(`  ${MARKS[status] ?? "·"} ${name.padEnd(22)} ${detail}`);
    },
    next(message) {
      report.next.push(clean(message));
    },
    /** Report fields go through the same cleaning as step lines before they are shown. */
    finalize() {
      for (const field of ["mcp", "skills", "instructions", "chats", "signIn", "restart", "provider", "model", "authIn", "backup"]) {
        if (report[field] != null) report[field] = clean(report[field]);
      }
      report.mcpUrl = clean(report.mcpUrl);
      return report;
    },

    /**
     * Run a host CLI command as one step. `inherit` hands the terminal to the child
     * (sign-in prints a URL and waits for the browser). `input` goes to the child's stdin:
     * an API key is only ever passed that way, never as an argument, because arguments
     * show in the process list. In a dry run nothing runs.
     */
    async exec(name, cmd, args, { inherit = false, tty = false, allowFail = false, okWhen, input } = {}) {
      refuseKeyInArgv(cmd, args);
      const shown = `${cmd} ${args.map((a) => (/\s|["{]/.test(a) ? `'${a}'` : a)).join(" ")}`;
      if (dryRun) {
        ctx.step(name, "skipped", `would run: ${shown}`);
        return { ok: true, code: 0, stdout: "", stderr: "" };
      }
      if (inherit) say(`  ${MARKS.pending} ${name.padEnd(22)} ${shown}`);
      const res = await runner(cmd, args, { inherit, tty, env, input });
      const output = `${res.stdout}\n${res.stderr}`;
      const ok = res.code === 0 || (okWhen ? okWhen(output) : false);
      if (ok) ctx.step(name, "ok", inherit ? "done" : shown);
      else {
        const tail = output.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
        ctx.step(name, allowFail ? "skipped" : "failed", `${shown} exited ${res.code}${tail ? `: ${tail}` : ""}`);
      }
      return { ok, ...res };
    },

    /** Set one entry in a JSON config file; falls back to a manual snippet when it cannot. */
    writeJson(name, file, keyPath, entry, { init } = {}) {
      const res = upsertJsonEntry(file, keyPath, entry, { dryRun, secret: Boolean(apiKey), init });
      if (res.status === "manual") {
        ctx.step(name, "manual", `${file}: ${res.reason}`);
        ctx.next(`Add this to ${file}:\n${res.snippet}`);
        return false;
      }
      ctx.step(name, "ok", `${file} (${dryRun ? `would be ${res.status}` : res.status})`);
      return true;
    },
    removeJson(name, file, keyPath) {
      const res = removeJsonEntry(file, keyPath, { dryRun });
      if (res.status === "manual") {
        ctx.step(name, "manual", `${file}: ${res.reason}`);
        ctx.next(`Remove "${keyPath.join(".")}" from ${file}.`);
        return;
      }
      ctx.step(name, res.status === "removed" ? "ok" : "skipped", `${file} (${res.status})`);
    },

    /** Run a host command only to read its output: no step, nothing in a dry run. */
    async query(cmd, args) {
      refuseKeyInArgv(cmd, args);
      if (dryRun) return { code: 0, stdout: "", stderr: "" };
      return runner(cmd, args, { env });
    },
    /** Run a read-only command (`ps`, `codex debug models`), in a dry run too: it changes nothing. */
    async probe(cmd, args, { env: probeEnv } = {}) {
      refuseKeyInArgv(cmd, args);
      return runner(cmd, args, { env: probeEnv ?? env });
    },

    /** Apply a text edit (TOML/YAML block) to a file. */
    editText(name, file, edit) {
      const before = readIfExists(file);
      const res = edit(before);
      if (res.status === "manual") {
        ctx.step(name, "manual", `${file}: ${res.reason}`);
        return false;
      }
      if (res.status === "unchanged" || res.status === "absent") {
        ctx.step(name, res.status === "absent" ? "skipped" : "ok", `${file} (${res.status})`);
        return true;
      }
      if (!dryRun) writeFileSafely(file, res.text, { secret: Boolean(apiKey) });
      ctx.step(name, "ok", `${file} (${dryRun ? `would be ${res.status}` : res.status})`);
      return true;
    },

    installSkillsTo(dir) {
      if (!skills) {
        ctx.step("Skills", "skipped", "--no-skills");
        return;
      }
      const res = installSkills(dir, { dryRun });
      for (const name of res.skipped) ctx.next(`${path.join(dir, name)} already exists and was not installed by this CLI; left as is.`);
      ctx.step("Skills", "ok", `${res.installed.length} in ${dir}`);
      report.skills = `${res.installed.join(", ")} in ${dir}`;
    },
    removeSkillsFrom(dir, names) {
      const res = removeSkills(dir, { dryRun, ...(names ? { names } : {}) });
      ctx.step("Skills", res.removed.length ? "ok" : "skipped", res.removed.length ? `removed from ${dir}` : `none in ${dir}`);
    },
  };
  return ctx;
}

