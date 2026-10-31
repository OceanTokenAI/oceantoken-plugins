import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MCP_URL, MARKETPLACE, PLUGIN_ID, PLUGIN_REPO, SERVER_NAME } from "../constants.js";
import { exists, readIfExists } from "../lib/fsutil.js";
import { signInInApp } from "./common.js";
import { claudeUnuse, claudeUse } from "./provider-switch.js";

const claudeDir = (ctx) => ctx.env.CLAUDE_CONFIG_DIR || ctx.path(".claude");
/** Where Claude Code keeps user-scope MCP servers: ~/.claude.json, or the legacy ~/.claude/.config.json. */
function claudeJson(ctx) {
  const legacy = path.join(claudeDir(ctx), ".config.json");
  if (exists(legacy)) return legacy;
  return path.join(ctx.env.CLAUDE_CONFIG_DIR || ctx.home, ".claude.json");
}
const PLUGIN_SERVER = `plugin:${MARKETPLACE}:${SERVER_NAME}`;

/** The env block of ~/.claude/settings.json, where `use claude-code` points Claude Code at OceanToken. */
function settingsEnv(ctx) {
  try {
    const env = JSON.parse(readIfExists(path.join(claudeDir(ctx), "settings.json")) ?? "{}").env;
    return env && typeof env === "object" && !Array.isArray(env) ? env : {};
  } catch {
    return {};
  }
}
const onOceanToken = (env) => /oceantoken/i.test(String(env.ANTHROPIC_BASE_URL ?? ""));
const INSTALL =
  "Install Claude Code first: npm install -g @anthropic-ai/claude-code, the Claude desktop app, or the Claude Code extension for VS Code or Cursor.";

const versionOf = (name) => (name.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
const newerFirst = (a, b) => {
  const [x, y] = [versionOf(a.version), versionOf(b.version)];
  for (let i = 0; i < 3; i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The `claude` executable. The desktop app and the IDE extensions each ship their
 * own copy and put none on PATH, so an agent running inside them has no `claude`
 * command; look where they keep it and take the newest.
 */
export function findClaude(ctx) {
  const onPath = ctx.which("claude");
  if (onPath) return onPath;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const found = [];

  const appData = ctx.env.APPDATA || ctx.path("AppData", "Roaming");
  const desktop =
    process.platform === "darwin"
      ? ctx.path("Library", "Application Support", "Claude", "claude-code")
      : process.platform === "win32"
        ? path.join(appData, "Claude", "claude-code")
        : path.join(ctx.env.XDG_CONFIG_HOME || ctx.path(".config"), "Claude", "claude-code");
  for (const version of listDir(desktop)) {
    const file =
      process.platform === "darwin"
        ? path.join(desktop, version, "claude.app", "Contents", "MacOS", "claude")
        : path.join(desktop, version, exe);
    if (exists(file)) found.push({ file, version });
  }

  for (const ide of [".cursor", ".vscode", ".vscode-insiders", ".windsurf", ".vscode-oss"]) {
    const extensions = ctx.path(ide, "extensions");
    for (const name of listDir(extensions)) {
      if (!name.startsWith("anthropic.claude-code-")) continue;
      const file = path.join(extensions, name, "resources", "native-binary", exe);
      if (exists(file)) found.push({ file, version: name });
    }
  }
  found.sort(newerFirst);
  return found[0]?.file ?? null;
}

const manualSignIn = `Sign in: in Claude Code run /mcp, choose ${PLUGIN_SERVER} and select Authenticate.`;

export default {
  id: "claude-code",
  label: "Claude Code",
  aliases: ["claude", "claudecode", "claude-code-cli", "claude-desktop"],
  detect: (ctx) => Boolean(findClaude(ctx)) || exists(claudeDir(ctx)),

  async connect(ctx) {
    const claude = findClaude(ctx);
    if (!claude) {
      ctx.step("claude CLI", "failed", "no Claude Code found (PATH, desktop app or IDE extension)");
      ctx.next(INSTALL);
      return;
    }
    if (ctx.native) {
      const added = await ctx.exec("Marketplace", claude, ["plugin", "marketplace", "add", PLUGIN_REPO], {
        okWhen: (out) => /already/i.test(out),
      });
      if (!added.ok) return;
      await ctx.exec("Marketplace refresh", claude, ["plugin", "marketplace", "update", MARKETPLACE], {
        allowFail: true,
      });
      const plugin = await ctx.exec("Plugin", claude, ["plugin", "install", PLUGIN_ID], {
        okWhen: (out) => /already installed/i.test(out),
      });
      if (!plugin.ok) return;
      await ctx.exec("Plugin update", claude, ["plugin", "update", PLUGIN_ID], { allowFail: true });
      ctx.report.mcp = `${PLUGIN_SERVER} via plugin ${PLUGIN_ID}`;
      ctx.report.skills = `via plugin ${PLUGIN_ID}`;

      const servers = `${(await ctx.query(claude, ["mcp", "list"])).stdout}`;
      const connector = servers
        .split("\n")
        .find((line) => line.startsWith("claude.ai ") && line.includes(new URL(DEFAULT_MCP_URL).host));
      if (connector) {
        ctx.next(
          `Your claude.ai account also has an OceanToken connector (${connector.split(":")[0]}), so the tools appear twice. ` +
            "Remove it under claude.ai → Settings → Connectors, or keep it and remove the plugin.",
        );
      }
      const pluginLine = servers.split("\n").find((line) => line.startsWith(`${PLUGIN_SERVER}:`)) || "";
      if (/✓|connected/i.test(pluginLine) && !/needs auth/i.test(pluginLine)) {
        ctx.step("Sign-in", "ok", "already signed in");
        ctx.report.signIn = "done (already signed in)";
      } else if (!ctx.login) {
        ctx.step("Sign-in", "skipped", "--no-login");
        ctx.report.signIn = "not started";
        ctx.next(`${manualSignIn} Or run: claude mcp login ${PLUGIN_SERVER}`);
      } else {
        // claude mcp login opens the browser and waits on a loopback callback, but only
        // with a terminal, so it gets one even when an agent runs this CLI.
        const res = await ctx.exec("Sign-in", claude, ["mcp", "login", PLUGIN_SERVER], { inherit: true, tty: true });
        ctx.report.signIn = ctx.dryRun ? "not started (dry run)" : res.ok ? "done" : "failed";
        if (!res.ok) ctx.next(manualSignIn);
      }
    } else {
      if (ctx.headers) {
        // `claude mcp add --header` would put the key on a command line (QA-093), so the
        // user-scope entry goes straight into the file `claude mcp add` writes.
        const file = claudeJson(ctx);
        const entry = { type: "http", url: ctx.mcpUrl, headers: ctx.headers };
        if (!ctx.writeJson("MCP server", file, ["mcpServers", SERVER_NAME], entry)) return;
        ctx.report.mcp = `${SERVER_NAME} (user scope, in ${file})`;
      } else {
        // Replace rather than duplicate a user-scope entry from an earlier run.
        await ctx.exec("Old entry", claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"], { allowFail: true });
        const args = ["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, ctx.mcpUrl];
        const added = await ctx.exec("MCP server", claude, args);
        if (!added.ok) return;
        ctx.report.mcp = `${SERVER_NAME} (user scope)`;
      }
      ctx.installSkillsTo(`${claudeDir(ctx)}/skills`);
      signInInApp(ctx, `Sign in: in Claude Code run /mcp, choose ${SERVER_NAME} and select Authenticate.`);
    }
    ctx.report.restart = "start a new Claude Code session (in the desktop app, a new chat)";
  },

  async disconnect(ctx) {
    const claude = findClaude(ctx);
    if (claude) {
      await ctx.exec("Plugin", claude, ["plugin", "uninstall", PLUGIN_ID], { allowFail: true });
      await ctx.exec("MCP server", claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"], { allowFail: true });
    }
    ctx.removeSkillsFrom(`${claudeDir(ctx)}/skills`);
  },

  use: claudeUse,
  unuse: claudeUnuse,
  /** The key a `use claude-code` in force stored, so a rerun needs none pasted. */
  savedKey: (ctx) => {
    const env = settingsEnv(ctx);
    return onOceanToken(env) && typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN : null;
  },
  /** What Claude Code runs on now, for `status`. */
  runsOn: (ctx) => {
    const env = settingsEnv(ctx);
    if (onOceanToken(env)) return { oceantoken: true, detail: env.ANTHROPIC_MODEL || "Claude models on OceanToken" };
    if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) return { oceantoken: false, detail: "another gateway or API key (settings.json env)" };
    return { oceantoken: false, detail: "its own sign-in (your Claude plan)" };
  },
};
