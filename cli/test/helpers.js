import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli.js";

export const KEY = "sk-TestKey1234567890abcdef";

export function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceantoken-cli-"));
}

/**
 * Run the CLI against a temp home with fake host binaries and a fake network.
 * `bins` lists the host CLIs that "exist"; every call to them is recorded and
 * answered by `respond` (default: success).
 */
export async function cli(argv, { home = tempHome(), bins = [], respond, models = 200, reachable = true, env = {}, promptKey, confirm, appEngines = [] } = {}) {
  const calls = [];
  const fetched = [];
  const out = [];
  const err = [];
  const code = await main(argv, {
    home,
    env: { PATH: "/nonexistent", ...env },
    ...(promptKey ? { promptKey } : {}),
    ...(confirm ? { confirm } : {}),
    // Never the desktop app installed on the machine running the tests.
    appEngines,
    print: (l) => out.push(l),
    printErr: (l) => err.push(l),
    whichImpl: (cmd) => (bins.includes(cmd) ? `/fake/bin/${cmd}` : null),
    runner: async (cmd, args, opts) => {
      calls.push({ cmd, args, inherit: Boolean(opts?.inherit), tty: Boolean(opts?.tty), input: opts?.input });
      return respond ? respond(cmd, args) : { code: 0, stdout: "", stderr: "" };
    },
    fetchImpl: async (url, init) => {
      fetched.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
      if (String(url).includes("/.well-known/")) {
        if (!reachable) throw new Error("offline");
        return { ok: true, status: 200 };
      }
      // `models` is a status code, or the model ids /v1/models lists (status 200).
      if (Array.isArray(models)) return { ok: true, status: 200, json: async () => ({ data: models.map((id) => ({ id })) }) };
      return { ok: models === 200, status: models };
    },
  });
  return { code, home, calls, fetched, out: out.join("\n"), err: err.join("\n") };
}

export const read = (file) => fs.readFileSync(file, "utf8");
export const readJson = (file) => JSON.parse(read(file));
export const exists = (file) => fs.existsSync(file);

/** Every file below dir, recursively. */
export function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
  });
}

/** QA-093: an argument shows in `ps` to every user of the machine, so the key may only travel on stdin. */
export function assertKeyNotInArgv(assert, res, label = "") {
  for (const c of res.calls) {
    const argv = [c.cmd, ...c.args].map(String);
    assert.ok(!argv.some((a) => a.includes(KEY)), `${label} key on a command line: ${argv.join(" ")}`);
  }
}
