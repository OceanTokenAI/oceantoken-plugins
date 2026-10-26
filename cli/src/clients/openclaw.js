import { CLAWHUB_PACKAGE, SERVER_NAME } from "../constants.js";
import { exists } from "../lib/fsutil.js";
import { requireCli, signIn } from "./common.js";

const openclawDir = (ctx) => ctx.env.OPENCLAW_HOME || ctx.path(".openclaw");
const INSTALL = "Install OpenClaw first (Node 24+): npm install -g openclaw (https://docs.openclaw.ai).";

export default {
  id: "openclaw",
  label: "OpenClaw",
  aliases: ["claw", "clawdbot"],
  detect: (ctx) => Boolean(ctx.which("openclaw")) || exists(openclawDir(ctx)),

  async connect(ctx) {
    if (!requireCli(ctx, "openclaw", INSTALL)) return;
    if (ctx.skills) {
      // The ClawHub package carries the skills. Its own server entry cannot sign in,
      // so the managed entry below (same name) replaces it.
      const installed = exists(`${openclawDir(ctx)}/extensions/${SERVER_NAME}`);
      const res = installed
        ? await ctx.exec("Plugin update", "openclaw", ["plugins", "update", SERVER_NAME, "--accept-capabilities"], { allowFail: true })
        : await ctx.exec("Plugin", "openclaw", ["plugins", "install", CLAWHUB_PACKAGE, "--accept-capabilities"]);
      if (res.ok) ctx.report.skills = `via ${CLAWHUB_PACKAGE.replace("clawhub:", "")} from ClawHub`;
    } else {
      ctx.step("Skills", "skipped", "--no-skills");
    }
    const entry = { url: ctx.mcpUrl, transport: "streamable-http" };
    // `mcp set` takes the entry as an argument, where a key would show in the process list
    // (QA-093). With a key the same entry goes through `config patch` on stdin, replacing the
    // whole entry so an earlier `auth: "oauth"` (which makes OpenClaw ignore the header) is gone.
    const set = ctx.headers
      ? await ctx.exec("MCP server", "openclaw", ["config", "patch", "--stdin", "--replace-path", `mcp.servers.${SERVER_NAME}`], {
          input: JSON.stringify({ mcp: { servers: { [SERVER_NAME]: { ...entry, headers: ctx.headers } } } }),
        })
      : await ctx.exec("MCP server", "openclaw", ["mcp", "set", SERVER_NAME, JSON.stringify({ ...entry, auth: "oauth" })]);
    if (!set.ok) return;
    ctx.report.mcp = `${SERVER_NAME} (OpenClaw-managed)`;
    await signIn(ctx, "openclaw", ["mcp", "login", SERVER_NAME]);
    ctx.report.restart = "restart the OpenClaw gateway so the plugin loads";
  },

  async disconnect(ctx) {
    if (!ctx.which("openclaw")) {
      ctx.step("openclaw CLI", "manual", "`openclaw` is not on PATH");
      return;
    }
    await ctx.exec("MCP server", "openclaw", ["mcp", "unset", SERVER_NAME], { allowFail: true });
    await ctx.exec("Plugin", "openclaw", ["plugins", "uninstall", SERVER_NAME], { allowFail: true });
  },
};
