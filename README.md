<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/oceantoken-horizontal-white.svg">
    <img src="assets/oceantoken-horizontal-black.svg" alt="OceanToken" height="56">
  </picture>
</p>

# OceanToken plugins for coding agents

[OceanToken](https://oceantoken.ai) is one account for 500+ AI models: GPT, Claude, Gemini,
DeepSeek and Qwen for text; GPT Image, Seedream, Recraft and Gemini for images; Seedance, Veo,
Sora and Wan for video; plus text-to-speech and transcription. This plugin brings all of it into
your coding agent: one command connects Codex, Claude Code, Cursor, Gemini CLI, OpenClaw,
OpenCode, VS Code, WorkBuddy, Hermes Agent and Windsurf, and any other MCP client can add the
server by hand. Your agent can find a model, check what it costs, generate the asset, and save
it into your project.

## What your agent gets

| Tool | What it does |
|---|---|
| `search_models` | Search the catalog by name, type, publisher, capability and price. |
| `get_model` | Pricing, limits, and the sizes, durations and inputs a model accepts. |
| `estimate_cost` | What a request will cost before it runs, and whether your balance covers it. |
| `generate_image` | Text-to-image and image edits, with previews and download links. |
| `create_video` + `get_job` | Video from text, from a first (and last) frame, or from reference media. |
| `generate_speech` | Voice-overs and narration. |
| `transcribe_audio` | Transcripts and SRT/VTT subtitles. |
| `ask_model` | Hand a sub-task to another model: a cheaper one, or a second opinion. |
| `upload_file` | Use local files as references. |
| `get_account` | Balance, available balance and spend. |

Three skills teach the agent how to use them well:

- `oceantoken-media`: produce images, video and audio for a project.
- `oceantoken-models`: choose, price and delegate.
- `oceantoken-setup`: run Codex or Claude Code itself on OceanToken, or wire up your app.

The same plugin folder carries manifests for each host (`.codex-plugin`, `.claude-plugin`,
`.cursor-plugin`, and the open [Agent Plugins](https://agent-plugins.org) `plugin.json`), so
every host gets the same tools and skills.

## Install

You need an OceanToken account ([sign up](https://app.oceantoken.ai/ui/signup/?utm_source=oceantoken-plugins&utm_medium=readme)) with some credit.

### One command, any agent

Ask your agent:

> Install OceanToken for me by following https://mcp.oceantoken.ai/install

or run it yourself:

```bash
npx -y @oceantoken/cli@latest connect <client>
```

`<client>` is one of `codex`, `claude-code`, `cursor`, `gemini`, `openclaw`, `opencode`, `vscode`,
`workbuddy`, `hermes` or `windsurf`. It installs the plugin or MCP entry and the three skills
(Windsurf / Devin Desktop has no skills folder, so it gets the server only), and starts the
sign-in. See [cli/](cli/) for options (API keys, dry run, disconnect, and `use` to run Codex or
Claude Code itself on OceanToken models) and the [guide](https://docs.oceantoken.ai/agents/connect)
for a walkthrough. The sections below do the same by hand.

### Codex

```bash
codex plugin marketplace add OceanTokenAI/oceantoken-plugins
codex plugin add oceantoken@oceantoken
codex mcp login oceantoken      # opens the OceanToken sign-in page
```

In the Codex app you can also add the marketplace, then install **OceanToken** from the Plugins
panel and sign in when asked.

### Claude Code

```text
/plugin marketplace add OceanTokenAI/oceantoken-plugins
/plugin install oceantoken@oceantoken
/mcp                             # pick "plugin:oceantoken:oceantoken" and authenticate
```

### Cursor

[![Add OceanToken to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=oceantoken&config=eyJ1cmwiOiJodHRwczovL21jcC5vY2VhbnRva2VuLmFpL21jcCJ9)

The button adds the MCP server; Cursor asks you to sign in the first time a tool runs. To get the
skills as well, install the plugin from this repository (it has a `.cursor-plugin` marketplace
manifest).

### Gemini CLI

```bash
gemini extensions install https://github.com/OceanTokenAI/oceantoken-plugins
```

Then, inside Gemini CLI, run `/mcp auth oceantoken` and sign in. The extension brings the MCP
server, the three skills and a short `GEMINI.md`.

### OpenClaw

```bash
openclaw plugins install clawhub:@oceantoken/oceantoken --accept-capabilities
openclaw mcp set oceantoken '{"url":"https://mcp.oceantoken.ai/mcp","transport":"streamable-http","auth":"oauth"}'
openclaw mcp login oceantoken
```

The [ClawHub package](https://clawhub.ai/oceantoken/plugins/oceantoken) brings the three skills
(also on ClawHub on their own: `oceantoken-media`, `oceantoken-models`, `oceantoken-setup`). The
`mcp set` entry registers the server with OpenClaw so `mcp login` can sign you in; it replaces the
plugin's own unauthenticated entry of the same name.

### Any other MCP client

OceanToken is in the [official MCP Registry](https://registry.modelcontextprotocol.io) as
`ai.oceantoken/mcp`, so clients that browse the registry (VS Code and GitHub Copilot, for
example) can find it by name.

The server is `https://mcp.oceantoken.ai/mcp` (streamable HTTP). It supports OAuth with dynamic
client registration, so most clients just need the URL. To use an API key instead, send it as a
bearer token:

```bash
# Codex, without the plugin
export OCEANTOKEN_API_KEY=sk-...
codex mcp add oceantoken --url https://mcp.oceantoken.ai/mcp --bearer-token-env-var OCEANTOKEN_API_KEY

# Claude Code, without the plugin. The single quotes keep the key off the command line:
# Claude Code reads OCEANTOKEN_API_KEY from its environment when it starts.
claude mcp add --transport http oceantoken https://mcp.oceantoken.ai/mcp \
  --header 'Authorization: Bearer ${OCEANTOKEN_API_KEY}'
```

```json
{
  "mcpServers": {
    "oceantoken": { "type": "http", "url": "https://mcp.oceantoken.ai/mcp" }
  }
}
```

### Muse Code (Meta)

Add the server to the `mcp_servers` block of your Muse Code settings, then sign in:

```json
{
  "mcp_servers": {
    "oceantoken": { "transport": "streamable_http", "url": "https://mcp.oceantoken.ai/mcp" }
  }
}
```

```bash
muse mcp login oceantoken
```

Muse Code also reads skills from `~/.agents/skills`: copy the folders in
`plugins/oceantoken/skills/` there to get the OceanToken workflows.

## Make your agent reach for OceanToken

Agents choose their own tools. They use OceanToken for anything they cannot do
themselves (video, voice-overs, subtitles, models they don't have, cost
estimates). For images, Codex also has a built-in generator, so ask for
OceanToken by name, or make it a rule:

- **Ask explicitly**: `$oceantoken-media ...` in Codex, `/oceantoken:oceantoken-media ...`
  in Claude Code, or simply "use OceanToken to ...".
- **Make it a project rule** in `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code):

  ```markdown
  Generate images, video, voice-overs and subtitles with the OceanToken tools.
  Estimate the cost first and ask me before spending more than $2.
  ```

- **Skip approval prompts for the read-only tools** in Codex (`~/.codex/config.toml`):

  ```toml
  [plugins."oceantoken@oceantoken".mcp_servers.oceantoken.tools.search_models]
  approval_mode = "approve"
  [plugins."oceantoken@oceantoken".mcp_servers.oceantoken.tools.estimate_cost]
  approval_mode = "approve"
  [plugins."oceantoken@oceantoken".mcp_servers.oceantoken.tools.get_job]
  approval_mode = "approve"
  ```

## Signing in

The sign-in page offers two ways to connect:

- **Sign in**: your OceanToken email and password. This creates an API key for the connecting
  app, which you can see and revoke under
  [API keys](https://app.oceantoken.ai/ui/?page=api-keys&utm_source=oceantoken-plugins&utm_medium=readme)
  in the console.
- **API key**: paste a key you already have. Give it a credit limit if you want a cap for the
  agent.

Revoking the key disconnects the app immediately.

## Costs

You pay the model's usage from your prepaid OceanToken balance, at the prices on the
[Models page](https://oceantoken.ai/models?utm_source=oceantoken-plugins&utm_medium=readme). Ask your agent for an estimate first
(`estimate_cost`). Video jobs place a small hold when they start and charge the actual cost when
they finish. Failed jobs are not charged.

## Privacy and terms

Prompts and files go to the model you choose, through OceanToken, to produce your result.
Generated files are stored in your OceanToken storage and shared as time-limited links. See the
[privacy policy](https://app.oceantoken.ai/legal/privacy) and [terms](https://app.oceantoken.ai/legal/terms).

## Support

Open an [issue](https://github.com/OceanTokenAI/oceantoken-plugins/issues), or email
support@oceantoken.ai.
