# @oceantoken/cli

Connect your AI agent to [OceanToken](https://oceantoken.ai), one account for nearly 500 AI models
(chat, image, video, speech, transcription), in one command.

```sh
npx -y @oceantoken/cli@latest connect <client>
```

It adds the OceanToken MCP server (`https://mcp.oceantoken.ai/mcp`) and the three OceanToken
skills to the client, then starts the client's own OAuth sign-in where it has one. Windsurf /
Devin Desktop has no skills folder, so it gets the server only. It supports ten clients:

| Client | `<client>` | How it is set up | Sign-in |
|---|---|---|---|
| Codex | `codex` | Codex plugin from this repo's marketplace | `codex mcp login` (browser) |
| Claude Code (terminal, IDE extension, desktop app) | `claude-code` | Claude Code plugin from this repo's marketplace | `claude mcp login` (browser) |
| Cursor | `cursor` | `~/.cursor/mcp.json` + `~/.cursor/skills` | Cursor Settings → Tools & MCP |
| Gemini CLI | `gemini` | Gemini CLI extension | `/mcp auth oceantoken` |
| OpenClaw | `openclaw` | ClawHub package + OpenClaw-managed server | `openclaw mcp login` (browser) |
| OpenCode | `opencode` | `~/.config/opencode/opencode.json` + skills | `opencode mcp auth` (browser) |
| VS Code (Copilot) | `vscode` | user `mcp.json` + `~/.copilot/skills` | in VS Code when the server starts |
| WorkBuddy | `workbuddy` | `~/.workbuddy-ai/mcp.json` + skills | in WorkBuddy |
| Hermes Agent | `hermes` | `~/.hermes/config.yaml` + skills | `hermes mcp login` (browser) |
| Windsurf / Devin Desktop | `windsurf` | `mcp_config.json` | in Cascade |

## Run Codex or Claude Code on OceanToken models

`connect` adds OceanToken's tools next to your agent's own models. `use` goes further and
makes OceanToken the model provider the agent itself runs on, billed to your OceanToken
balance:

```sh
npx -y @oceantoken/cli@latest use codex                    # GPT-5.5 through OceanToken
npx -y @oceantoken/cli@latest use codex --move-chats       # ...and your existing chats too
npx -y @oceantoken/cli@latest use codex --model deepseek/deepseek-v4-pro
npx -y @oceantoken/cli@latest use claude-code              # Opus/Sonnet/Haiku through OceanToken
npx -y @oceantoken/cli@latest unuse codex                  # back to how it was
```

| Agent | What `use` changes | What `unuse` does |
|---|---|---|
| Codex | `~/.codex/config.toml`: top-level `model_provider` / `model` and a `[model_providers.oceantoken]` table (Responses API). Your own `model =` line is commented out, not deleted. A model list for Codex's picker (`~/.codex/oceantoken-models.json`, named by `model_catalog_json`) with OceanToken's ids (`openai/gpt-6-luna`), built from your own Codex's list. Unless `--no-tools`: the OceanToken tools (an `[mcp_servers.oceantoken]` table with the same key, or the plugin if `connect codex` installed it), the skills in `~/.agents/skills`, and a short note in `~/.codex/AGENTS.md` that sends image, video and audio requests to those tools | Removes both blocks and uncomments your lines; removes the model list, and the tools, skills and note `use` added (not what `connect` added) |
| Claude Code | `~/.claude/settings.json` → `env`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, the Opus/Sonnet/Haiku model mapping (`ANTHROPIC_MODEL` with `--model`) | Puts back every value it replaced (saved in `~/.oceantoken/cli-state.json`) |

Codex refuses to start while `model_catalog_json` names a file that is missing or broken,
so leave `~/.codex/oceantoken-models.json` in place while `use` is on (`unuse` removes the
setting first, then the file; running `use codex` again rewrites it).

Codex on OceanToken has no built-in image tool (that comes with a ChatGPT plan), which is
why `use codex` adds OceanToken's tools: "generate an image of a cat" then runs on your
OceanToken balance instead of failing or going to a third-party app.

### Existing Codex chats

Codex keeps every chat on the provider it was started on, so after `use codex` your
earlier chats still run on your ChatGPT plan (and its limits); new chats use OceanToken.
`--move-chats` moves them too, and `unuse codex --move-chats` moves them back:

- Quit the ChatGPT app (and any `codex` you have running) first; the CLI refuses while
  Codex is running, because Codex rewrites these files while it runs.
- `use` changes only Codex's chat list (`~/.codex/state_5.sqlite`: each chat's provider,
  and its model under OceanToken's name, `gpt-6-astra` -> `openai/gpt-6-astra`). Chats on
  a model OceanToken does not offer stay where they are.
- `unuse` moves back the chats on OpenAI models. A ChatGPT plan cannot read the hidden
  reasoning OceanToken produced, so that reasoning is blanked in the chat files; the
  visible conversation is untouched. Chats on other publishers' models stay on OceanToken.
- Before anything changes, the chat list (and every chat file `unuse` edits) is copied to
  `~/.codex/backups/oceantoken-cli-<UTC time>/`, with a `manifest.json` of what moved.

Without `--move-chats`, `use` and `unuse` say how many chats stay behind and, in a
terminal, offer to move them (the default is no).

Without `--api-key`, `use` opens the API keys page and asks you to paste a key (hidden);
a later `use codex` reuses the key the first one saved.
`--use-env-key` keeps the key out of the files: Codex reads `OCEANTOKEN_API_KEY` itself,
Claude Code through `apiKeyHelper`. Every file is backed up before it is changed (see
[What it changes](#what-it-changes)), and a file that holds a key is made owner-only.

## Options

```text
Options for connect
  --api-key <key|->   Use an API key instead of OAuth sign-in ("-" reads it from stdin)
  --use-env-key       Use the key in OCEANTOKEN_API_KEY
  --no-login          Configure only; do not start the sign-in
  --no-skills         Do not install the OceanToken skills
  --dry-run           Show what would change without changing anything
  --json              Print the report as JSON
  --url <mcp-url>     MCP endpoint (default https://mcp.oceantoken.ai/mcp)

Options for use
  --api-key <key|->   The OceanToken API key (asked for when omitted)
  --use-env-key       Have the agent read the key from OCEANTOKEN_API_KEY instead of storing it
  --model <id>        Model to run on, e.g. deepseek/deepseek-v4-pro (default: GPT-5.5
                      for Codex; Claude's own Opus/Sonnet/Haiku for Claude Code)
  --api-base <url>    OceanToken API (default https://api.oceantoken.ai)
  --move-chats        Codex: also move your existing chats to OceanToken (with unuse:
                      back to your ChatGPT plan). Quit Codex first; a backup is made
  --no-tools          Codex: do not add OceanToken's image/video/speech tools and skills
  --url, --no-skills, --dry-run, --json   As for connect

Other options
  -h, --help          Show this help
  -v, --version       Print the CLI version
```

Create an API key at https://app.oceantoken.ai/ui/?page=api-keys&utm_source=oceantoken-plugins&utm_medium=readme
and hand it over with `--api-key -` (stdin) or `--use-env-key`; `--api-key <key>` itself would
leave it in your shell history and in the process list while the CLI runs.

```sh
printf %s "$OCEANTOKEN_API_KEY" | npx -y @oceantoken/cli@latest connect <client> --api-key -
```

The key is checked against the API that goes with the MCP endpoint: `https://api.oceantoken.ai`
by default, `api.<domain>` for an `--url` on `mcp.<domain>`. With any other `--url` the key is
not checked, so it goes nowhere except that server's config entry.

```sh
npx -y @oceantoken/cli@latest clients              # supported clients and which are installed
npx -y @oceantoken/cli@latest disconnect <client>  # remove what connect added
```

## What it changes

Only what OceanToken needs, and it is safe to run again:

- Codex, Claude Code and Gemini CLI get the official plugin (extension), installed with the
  host's own CLI. With an API key or `--url` they get one `oceantoken` server entry in their
  config instead.
- OpenClaw gets the ClawHub package (for the skills) and an OpenClaw-managed server entry.
- The other hosts get one `oceantoken` server entry in their MCP config file. Existing entries
  are kept, and a file with comments is never rewritten: you get the snippet to paste instead.
- Backups: before the CLI first edits a config file it copies it to `<file>.bak-oceantoken`,
  and it never overwrites that copy, so your original stays there however often you connect
  and disconnect (or `use` and `unuse`). Each later change also leaves
  `<file>.bak-oceantoken-<UTC time>` (for example `mcp.json.bak-oceantoken-20261004T081530Z`)
  with the file as it was just before. A backup is a plain, owner-only copy: if the file held
  an API key, so does the backup.
- Skills go into the host's own skills folder, marked so `disconnect` removes only what it
  installed.
- An API key is never passed to another program on its command line and never printed. It is
  written only to the host's own config file, made owner-only and backed up first as above:
  `~/.claude.json` for Claude Code, `~/.gemini/settings.json` for Gemini CLI,
  `~/.codex/config.toml` for Codex, the MCP config file for the others, and for `use`,
  `~/.codex/config.toml` or `~/.claude/settings.json`. OpenClaw receives it on stdin through
  `openclaw config patch` and writes `~/.openclaw/openclaw.json` itself.

## Docs

- Guide: https://docs.oceantoken.ai/agents/connect
- Manual setup for every host: https://github.com/OceanTokenAI/oceantoken-plugins#install
- Models and prices: https://oceantoken.ai/models?utm_source=oceantoken-plugins&utm_medium=readme

## For agents

An agent installing OceanToken for a user should follow
[INSTALL.md](https://mcp.oceantoken.ai/install).

MIT licensed.
