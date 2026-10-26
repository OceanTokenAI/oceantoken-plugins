import path from "node:path";
import { SERVER_NAME } from "../constants.js";
import { exists } from "../lib/fsutil.js";
import { removeBlock, upsertHermesServer } from "../lib/blocks.js";
import { signIn, signInInApp } from "./common.js";

// Hosts configured by writing their MCP config file directly. Each connect is:
// one server entry (OAuth, or a bearer header with --api-key) plus the skills in the
// host's own skills folder, so they do not show up twice in hosts that share ~/.agents.

const xdgConfig = (ctx) => ctx.env.XDG_CONFIG_HOME || ctx.path(".config");

export const cursor = {
  id: "cursor",
  label: "Cursor",
  aliases: ["cursor-ide", "cursor-agent"],
  file: (ctx) => ctx.path(".cursor", "mcp.json"),
  detect: (ctx) => exists(ctx.path(".cursor")) || Boolean(ctx.which("cursor")),
  async connect(ctx) {
    const entry = { url: ctx.mcpUrl, ...(ctx.headers ? { headers: ctx.headers } : {}) };
    if (!ctx.writeJson("MCP server", this.file(ctx), ["mcpServers", SERVER_NAME], entry)) return;
    ctx.report.mcp = `${SERVER_NAME} in ${this.file(ctx)}`;
    ctx.installSkillsTo(ctx.path(".cursor", "skills"));
    signInInApp(ctx, `Sign in: open Cursor Settings → Tools & MCP, find ${SERVER_NAME} and click Connect (or run any OceanToken tool and follow the prompt).`);
    ctx.report.restart = "reload the Cursor window";
  },
  async disconnect(ctx) {
    ctx.removeJson("MCP server", this.file(ctx), ["mcpServers", SERVER_NAME]);
    ctx.removeSkillsFrom(ctx.path(".cursor", "skills"));
  },
};

function vscodeUserDir(ctx) {
  if (process.platform === "darwin") return ctx.path("Library", "Application Support", "Code", "User");
  if (process.platform === "win32") return path.join(ctx.env.APPDATA || ctx.path("AppData", "Roaming"), "Code", "User");
  return path.join(xdgConfig(ctx), "Code", "User");
}

export const vscode = {
  id: "vscode",
  label: "VS Code (GitHub Copilot)",
  aliases: ["vs-code", "code", "copilot", "github-copilot"],
  file: (ctx) => path.join(vscodeUserDir(ctx), "mcp.json"),
  detect: (ctx) => Boolean(ctx.which("code")) || exists(vscodeUserDir(ctx)),
  async connect(ctx) {
    const entry = { type: "http", url: ctx.mcpUrl, ...(ctx.headers ? { headers: ctx.headers } : {}) };
    if (!ctx.writeJson("MCP server", this.file(ctx), ["servers", SERVER_NAME], entry)) return;
    ctx.report.mcp = `${SERVER_NAME} in ${this.file(ctx)}`;
    ctx.installSkillsTo(ctx.path(".copilot", "skills"));
    signInInApp(ctx, `Sign in: in VS Code run "MCP: List Servers", start ${SERVER_NAME} and allow the sign-in it asks for.`);
    ctx.report.restart = "reload the VS Code window";
  },
  async disconnect(ctx) {
    ctx.removeJson("MCP server", this.file(ctx), ["servers", SERVER_NAME]);
    ctx.removeSkillsFrom(ctx.path(".copilot", "skills"));
  },
};

function opencodeFile(ctx) {
  const dir = path.join(xdgConfig(ctx), "opencode");
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    if (exists(path.join(dir, name))) return path.join(dir, name);
  }
  return path.join(dir, "opencode.json");
}

export const opencode = {
  id: "opencode",
  label: "OpenCode",
  aliases: ["open-code", "sst-opencode"],
  detect: (ctx) => Boolean(ctx.which("opencode")) || exists(path.join(xdgConfig(ctx), "opencode")),
  async connect(ctx) {
    const entry = { type: "remote", url: ctx.mcpUrl, enabled: true, ...(ctx.headers ? { headers: ctx.headers } : {}) };
    const file = opencodeFile(ctx);
    const ok = ctx.writeJson("MCP server", file, ["mcp", SERVER_NAME], entry, {
      init: { $schema: "https://opencode.ai/config.json" },
    });
    if (!ok) return;
    ctx.report.mcp = `${SERVER_NAME} in ${file}`;
    ctx.installSkillsTo(path.join(xdgConfig(ctx), "opencode", "skills"));
    await signIn(ctx, "opencode", ["mcp", "auth", SERVER_NAME]);
    ctx.report.restart = "start a new OpenCode session";
  },
  async disconnect(ctx) {
    ctx.removeJson("MCP server", opencodeFile(ctx), ["mcp", SERVER_NAME]);
    ctx.removeSkillsFrom(path.join(xdgConfig(ctx), "opencode", "skills"));
  },
};

const hermesHome = (ctx) => ctx.env.HERMES_HOME || ctx.path(".hermes");

export const hermes = {
  id: "hermes",
  label: "Hermes Agent",
  aliases: ["hermes-agent", "nous-hermes"],
  detect: (ctx) => Boolean(ctx.which("hermes")) || exists(hermesHome(ctx)),
  async connect(ctx) {
    const file = path.join(hermesHome(ctx), "config.yaml");
    const ok = ctx.editText("MCP server", file, (text) => upsertHermesServer(text, ctx.mcpUrl, ctx.headers));
    if (!ok) {
      ctx.next(
        `Add this under mcp_servers in ${file}:\n  ${SERVER_NAME}:\n    url: "${ctx.mcpUrl}"\n    ${ctx.headers ? "headers:\n      Authorization: \"Bearer <your key>\"" : "auth: oauth"}`,
      );
      return;
    }
    ctx.report.mcp = `${SERVER_NAME} in ${file}`;
    ctx.installSkillsTo(path.join(hermesHome(ctx), "skills"));
    await signIn(ctx, "hermes", ["mcp", "login", SERVER_NAME]);
    ctx.report.restart = "start a new Hermes session";
  },
  async disconnect(ctx) {
    ctx.editText("MCP server", path.join(hermesHome(ctx), "config.yaml"), removeBlock);
    ctx.removeSkillsFrom(path.join(hermesHome(ctx), "skills"));
  },
};

export const workbuddy = {
  id: "workbuddy",
  label: "WorkBuddy",
  aliases: ["workbuddy-ai", "tencent-workbuddy"],
  file: (ctx) => ctx.path(".workbuddy-ai", "mcp.json"),
  detect: (ctx) => exists(ctx.path(".workbuddy-ai")),
  async connect(ctx) {
    const entry = { type: "streamableHttp", url: ctx.mcpUrl, ...(ctx.headers ? { headers: ctx.headers } : {}) };
    if (!ctx.writeJson("MCP server", this.file(ctx), ["mcpServers", SERVER_NAME], entry)) return;
    ctx.report.mcp = `${SERVER_NAME} in ${this.file(ctx)}`;
    ctx.installSkillsTo(ctx.path(".workbuddy-ai", "skills"));
    signInInApp(ctx, `Sign in: restart WorkBuddy and approve the OceanToken sign-in when it opens.`);
    ctx.report.restart = "restart WorkBuddy";
  },
  async disconnect(ctx) {
    ctx.removeJson("MCP server", this.file(ctx), ["mcpServers", SERVER_NAME]);
    ctx.removeSkillsFrom(ctx.path(".workbuddy-ai", "skills"));
  },
};

// Windsurf became Devin Desktop; the new app reads ~/.config/devin, older installs ~/.codeium/windsurf.
function windsurfFile(ctx) {
  const devin = path.join(xdgConfig(ctx), "devin");
  const legacy = ctx.path(".codeium", "windsurf");
  if (exists(devin)) return path.join(devin, "mcp_config.json");
  return path.join(legacy, "mcp_config.json");
}

export const windsurf = {
  id: "windsurf",
  label: "Windsurf / Devin Desktop",
  aliases: ["devin", "devin-desktop", "codeium"],
  detect: (ctx) => exists(path.join(xdgConfig(ctx), "devin")) || exists(ctx.path(".codeium", "windsurf")),
  async connect(ctx) {
    const file = windsurfFile(ctx);
    const entry = { serverUrl: ctx.mcpUrl, ...(ctx.headers ? { headers: ctx.headers } : {}) };
    if (!ctx.writeJson("MCP server", file, ["mcpServers", SERVER_NAME], entry)) return;
    ctx.report.mcp = `${SERVER_NAME} in ${file}`;
    ctx.report.skills = "not installed (this host has no skills folder)";
    signInInApp(ctx, `Sign in: in Cascade open MCP servers, refresh, and sign in to ${SERVER_NAME} when asked.`);
    ctx.report.restart = "refresh the MCP servers in Cascade";
  },
  async disconnect(ctx) {
    ctx.removeJson("MCP server", windsurfFile(ctx), ["mcpServers", SERVER_NAME]);
  },
};
