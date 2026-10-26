import { MARKER, MARKETPLACE, PLUGIN_ID, PLUGIN_REPO, SERVER_NAME } from "../constants.js";
import { exists, readIfExists } from "../lib/fsutil.js";
import { codexBlock, removeBlock, upsertCodexBlock } from "../lib/blocks.js";
import { requireCli, signIn } from "./common.js";
import { codexUnuse, codexUse } from "./codex-use.js";
import { codexProviderKey } from "../lib/provider.js";

const codexHome = (ctx) => ctx.env.CODEX_HOME || ctx.path(".codex");
const configFile = (ctx) => `${codexHome(ctx)}/config.toml`;
const INSTALL = "Install Codex first: npm install -g @openai/codex (https://developers.openai.com/codex).";

export default {
  id: "codex",
  label: "Codex",
  aliases: ["codex-cli", "openai-codex"],
  detect: (ctx) => Boolean(ctx.which("codex")) || exists(codexHome(ctx)),

  async connect(ctx) {
    if (ctx.native) {
      if (!requireCli(ctx, "codex", INSTALL)) return;
      // A key-based entry from an earlier `--api-key` connect would shadow the plugin's server.
      if (readIfExists(configFile(ctx))?.includes(MARKER)) {
        ctx.editText("Old API-key entry", configFile(ctx), removeBlock);
      }
      const added = await ctx.exec("Marketplace", "codex", ["plugin", "marketplace", "add", PLUGIN_REPO]);
      if (!added.ok) return;
      await ctx.exec("Marketplace refresh", "codex", ["plugin", "marketplace", "upgrade", MARKETPLACE], { allowFail: true });
      const plugin = await ctx.exec("Plugin", "codex", ["plugin", "add", PLUGIN_ID]);
      if (!plugin.ok) return;
      ctx.report.mcp = `${SERVER_NAME} via plugin ${PLUGIN_ID}`;
      ctx.report.skills = ctx.skills ? `via plugin ${PLUGIN_ID}` : "via plugin (--no-skills does not apply to plugins)";
      await signIn(ctx, "codex", ["mcp", "login", SERVER_NAME], "it opens the OceanToken sign-in page");
    } else {
      const ok = ctx.editText("MCP server", configFile(ctx), (text) =>
        upsertCodexBlock(text, codexBlock(ctx.mcpUrl, ctx.headers)),
      );
      if (!ok) {
        ctx.next(`Edit the [mcp_servers.${SERVER_NAME}] table in ${configFile(ctx)} by hand, or remove it and run this again.`);
        return;
      }
      ctx.report.mcp = `${SERVER_NAME} in ${configFile(ctx)}`;
      ctx.installSkillsTo(ctx.path(".agents", "skills"));
      await signIn(ctx, "codex", ["mcp", "login", SERVER_NAME]);
    }
    ctx.report.restart = "start a new Codex session";
  },

  async disconnect(ctx) {
    if (ctx.which("codex")) {
      await ctx.exec("Plugin", "codex", ["plugin", "remove", PLUGIN_ID], { allowFail: true });
    }
    ctx.editText("MCP server", configFile(ctx), removeBlock);
    ctx.removeSkillsFrom(ctx.path(".agents", "skills"));
  },

  use: codexUse,
  unuse: codexUnuse,
  /** The key an earlier `use codex` stored, so a rerun needs none pasted. */
  savedKey: (ctx) => codexProviderKey(readIfExists(configFile(ctx))),
};
