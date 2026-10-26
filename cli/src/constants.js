export const SERVER_NAME = "oceantoken";
export const DEFAULT_MCP_URL = "https://mcp.oceantoken.ai/mcp";
export const API_BASE = "https://api.oceantoken.ai";
/** Where `--use-env-key` reads the key, and where `use` tells the agent to read it. */
export const KEY_ENV = "OCEANTOKEN_API_KEY";
export const CONSOLE_UI = "https://app.oceantoken.ai/ui/";
export const DOCS_URL = "https://docs.oceantoken.ai/agents/connect";

/**
 * A console link that says it came from this CLI: `src=cli`, plus `tool=<client id>` when the
 * command names a client, so the console records a new account's entry as `cli:<id>`.
 * Always a /ui/ path: the bare app root redirects and drops the query string.
 */
export function cliConsoleUrl(pathAndQuery = "", tool) {
  const url = new URL(pathAndQuery, CONSOLE_UI);
  url.searchParams.set("src", "cli");
  if (tool) url.searchParams.set("tool", tool);
  return url.toString();
}

/** The API keys page; `tool` is the client id (codex, claude-code, ...) when there is one. */
export const keysUrl = (tool) => cliConsoleUrl("?page=api-keys", tool);
/** The sign-up page; `tool` as for keysUrl. */
export const signupUrl = (tool) => cliConsoleUrl("signup/", tool);

/** Kept for compatibility: the same links without a client. */
export const KEYS_URL = keysUrl();
export const SIGNUP_URL = signupUrl();

export const PLUGIN_REPO = "OceanTokenAI/oceantoken-plugins";
export const PLUGIN_REPO_URL = `https://github.com/${PLUGIN_REPO}`;
export const MARKETPLACE = "oceantoken";
export const PLUGIN_ID = "oceantoken@oceantoken";
export const CLAWHUB_PACKAGE = "clawhub:@oceantoken/oceantoken";

export const SKILL_NAMES = ["oceantoken-media", "oceantoken-models", "oceantoken-setup"];

/** Written next to every file block and skill folder this CLI owns, so disconnect removes only those. */
export const MARKER = "added by @oceantoken/cli";
