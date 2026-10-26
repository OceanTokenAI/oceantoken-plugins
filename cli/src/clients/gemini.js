import path from "node:path";
import { PLUGIN_REPO_URL, SERVER_NAME } from "../constants.js";
import { exists } from "../lib/fsutil.js";
import { requireCli, signInInApp } from "./common.js";

const INSTALL = "Install Gemini CLI first: npm install -g @google/gemini-cli (https://geminicli.com).";
/** Gemini CLI's own folder; GEMINI_CLI_HOME stands in for the home directory, as in Gemini CLI. */
const geminiDir = (ctx) => path.join(ctx.env.GEMINI_CLI_HOME || ctx.home, ".gemini");
/** User settings, where `gemini mcp add --scope user` writes its servers. */
const geminiSettings = (ctx) => path.join(geminiDir(ctx), "settings.json");

export default {
  id: "gemini",
  label: "Gemini CLI",
  aliases: ["gemini-cli", "google-gemini"],
  detect: (ctx) => Boolean(ctx.which("gemini")) || exists(geminiDir(ctx)),

  async connect(ctx) {
    if (!requireCli(ctx, "gemini", INSTALL)) return;
    if (ctx.native) {
      const installed = exists(path.join(geminiDir(ctx), "extensions", SERVER_NAME, "gemini-extension.json"));
      const res = installed
        ? await ctx.exec("Extension update", "gemini", ["extensions", "update", SERVER_NAME])
        : await ctx.exec("Extension", "gemini", ["extensions", "install", PLUGIN_REPO_URL, "--consent"]);
      if (!res.ok) return;
      ctx.report.mcp = `${SERVER_NAME} via the ${SERVER_NAME} extension`;
      ctx.report.skills = `via the ${SERVER_NAME} extension`;
      signInInApp(ctx, `Sign in: in Gemini CLI run /mcp auth ${SERVER_NAME}.`);
    } else {
      // A user-scope server overrides the extension's server of the same name.
      if (ctx.headers) {
        // `gemini mcp add --header` would put the key on a command line (QA-093), so the
        // entry goes straight into the user settings file that command writes.
        const file = geminiSettings(ctx);
        const entry = { httpUrl: ctx.mcpUrl, headers: ctx.headers };
        if (!ctx.writeJson("MCP server", file, ["mcpServers", SERVER_NAME], entry)) return;
        ctx.report.mcp = `${SERVER_NAME} (user settings, in ${file})`;
      } else {
        await ctx.exec("Old entry", "gemini", ["mcp", "remove", "--scope", "user", SERVER_NAME], { allowFail: true });
        const args = ["mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, ctx.mcpUrl];
        const added = await ctx.exec("MCP server", "gemini", args);
        if (!added.ok) return;
        ctx.report.mcp = `${SERVER_NAME} (user settings)`;
      }
      ctx.installSkillsTo(path.join(geminiDir(ctx), "skills"));
      signInInApp(ctx, `Sign in: in Gemini CLI run /mcp auth ${SERVER_NAME}.`);
    }
    ctx.report.restart = "start a new Gemini CLI session";
  },

  async disconnect(ctx) {
    if (ctx.which("gemini")) {
      await ctx.exec("Extension", "gemini", ["extensions", "uninstall", SERVER_NAME], { allowFail: true });
      await ctx.exec("MCP server", "gemini", ["mcp", "remove", "--scope", "user", SERVER_NAME], { allowFail: true });
    }
    ctx.removeSkillsFrom(path.join(geminiDir(ctx), "skills"));
  },
};
