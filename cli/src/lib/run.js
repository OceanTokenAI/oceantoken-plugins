import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

/** Absolute path of an executable on PATH, or null. */
export function which(cmd, env = process.env) {
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = isWindows ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext.toLowerCase());
      const upper = path.join(dir, cmd + ext);
      for (const file of new Set([candidate, upper])) {
        try {
          if (fs.statSync(file).isFile()) return file;
        } catch {
          // not here
        }
      }
    }
  }
  return null;
}

/** Replace every secret in text with a placeholder. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("<hidden>");
  }
  return out;
}

function quoteForCmd(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

const shQuote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

// `script` needs its stdin to be a real pipe that stays open and silent: a socket
// (Node's "pipe", or an agent's shell) makes macOS `script` fail with
// "tcgetattr/ioctl: Operation not supported on socket", and an input that ends
// (/dev/null) is passed on to the child as end-of-file, so it stops waiting for
// the browser. `sleep` provides that pipe; when `script` exits, the sleep is
// stopped and `script`'s exit status is returned.
const PIPED_SCRIPT = (inner) => `sleep 86400 | { ${inner}; rc=$?; pkill -P $$ sleep 2>/dev/null; exit $rc; }`;

/**
 * The same command run inside a pseudo-terminal by the system `script` tool, or
 * null when there is none (Windows). Some sign-in commands (`claude mcp login`)
 * refuse to start without a terminal, and an agent runs this CLI without one.
 */
export function ttyCommand(exe, args, { platform = process.platform, env = process.env } = {}) {
  if (!which("script", env) || !which("sh", env)) return null;
  if (platform === "darwin" || platform.endsWith("bsd")) {
    return { cmd: "sh", args: ["-c", PIPED_SCRIPT('script -q /dev/null "$@"'), "sh", exe, ...args] };
  }
  if (platform === "linux") {
    const line = [exe, ...args].map(shQuote).join(" ");
    return { cmd: "sh", args: ["-c", PIPED_SCRIPT('script -q -e -c "$1" /dev/null'), "sh", line] };
  }
  return null;
}

/**
 * Run a command without a shell.
 *
 * inherit: the child shares this terminal (used for sign-in, which prints a URL and waits).
 * Otherwise stdout/stderr are captured and returned.
 * tty: also give the child a terminal when this process has none (see ttyCommand).
 * input: text written to the child's stdin, for anything secret: an argument would show
 * in the process list.
 */
export function run(cmd, args, { inherit = false, tty = false, input, env = process.env, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    let exe = which(cmd, env) || cmd;
    let argv = args;
    let stdio = inherit ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"];
    if (tty && !process.stdin.isTTY) {
      const wrapped = ttyCommand(exe, args, { env });
      if (wrapped) {
        exe = which(wrapped.cmd, env) || wrapped.cmd;
        argv = wrapped.args;
        stdio = ["ignore", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"];
      }
    }
    const useShell = isWindows && /\.(cmd|bat)$/i.test(exe);
    const child = spawn(useShell ? quoteForCmd(exe) : exe, useShell ? argv.map(quoteForCmd) : argv, {
      env,
      shell: useShell,
      stdio,
    });
    if (input !== undefined && child.stdin) {
      // A child that exits without reading its input must not crash this process (EPIPE).
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err.message || err) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
  });
}
