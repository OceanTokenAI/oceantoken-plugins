---
name: oceantoken-setup
description: Configure OceanToken as the model provider for Codex or Claude Code (run the agent itself on OceanToken models and balance), or connect an application's code to the OceanToken API. Use when the user asks to switch Codex or Claude Code to OceanToken, to call OceanToken models from their own app, to set up OCEANTOKEN_API_KEY, or to fix 401 / 403 / budget errors from the OceanToken API. Also for Chinese requests such as 把 Codex／Claude Code 换成 OceanToken、配置 API key、401、403、余额不足.
metadata:
  openclaw:
    homepage: https://oceantoken.ai
    envVars:
      - name: OCEANTOKEN_API_KEY
        required: false
        description: OceanToken API key, only when configuring an app or the agent's own model provider to call the OceanToken API.
---

# Setting up OceanToken as a provider

OceanToken's API is OpenAI-compatible at `https://api.oceantoken.ai/v1`
(chat completions, responses, images, videos, audio, embeddings), and Claude
models also answer the Anthropic Messages API at `https://api.oceantoken.ai`.
Auth is `Authorization: Bearer sk-...`.

Only change configuration when the user asked for this setup. Before writing
any file (agent config, settings, `.env`), show the exact change and get a
yes; never write a key anywhere without that confirmation.

## The key

1. The user creates a key at https://app.oceantoken.ai/ui/?page=api-keys&utm_source=oceantoken-plugins&utm_medium=skill&utm_campaign=oceantoken-setup (a
   credit limit per key is a good idea for agents).
2. Store it as an environment variable, never in a repository file:
   `export OCEANTOKEN_API_KEY=sk-...` in the shell profile, or a `.env` that is
   listed in `.gitignore`.
3. Check it: `curl -s https://api.oceantoken.ai/v1/models -H "Authorization: Bearer $OCEANTOKEN_API_KEY" | head -c 300`.

## Codex on OceanToken

Keep the user's default setup untouched and make OceanToken one flag away. Pick
the model with `search_models` (type `chat`, capability `tools`). Tested with
Codex 0.154: `openai/gpt-5.5`, `anthropic/claude-sonnet-5.5`,
`deepseek/deepseek-v4.1-flash` and `qwen/qwen3.8-max-0902` all finish coding
tasks; DeepSeek is by far the cheapest. For a model that is not OpenAI's, Codex
prints "Model metadata … not found. Defaulting to fallback metadata"; that
warning is harmless. Do not pick `aion-labs/aion-2.0`
for Codex or any agent that runs tools: after a tool call it tends to write its
final answer into its reasoning, so the turn shows no answer. It is fine for
plain chat.

Check `codex --version` first. Codex 0.135 and later keep each profile in its
own file, `~/.codex/<name>.config.toml` (under `$CODEX_HOME` if that is set),
and refuse `--profile oceantoken` while `config.toml` still has a
`[profiles.oceantoken]` table or a `profile = "oceantoken"` line.

1. Append the provider to `~/.codex/config.toml`. On its own it changes nothing:

   ```toml
   [model_providers.oceantoken]
   name = "OceanToken"
   base_url = "https://api.oceantoken.ai/v1"
   env_key = "OCEANTOKEN_API_KEY"
   wire_api = "responses"
   ```

2. Create `~/.codex/oceantoken.config.toml` with these two top-level lines (no
   table header):

   ```toml
   model_provider = "oceantoken"
   model = "openai/gpt-5.5"
   ```

   If `config.toml` already has a `[profiles.oceantoken]` table or a
   `profile = "oceantoken"` line (earlier OceanToken instructions wrote them),
   delete them there once this file exists.

   Codex 0.134 and earlier has no profile files: put the same two lines under
   `[profiles.oceantoken]` in `config.toml` instead.

Run with `codex --profile oceantoken`, and verify with
`codex exec --skip-git-repo-check --profile oceantoken "Reply with the single word OK"`.
Plain `codex` keeps running the user's own setup, which is how they switch
back. To remove OceanToken, delete `oceantoken.config.toml` and the
`[model_providers.oceantoken]` table.

Only if the user wants OceanToken as the default with no flag: put the two
lines at the top of `config.toml`, before the first `[table]`, replacing any
`model` or `model_provider` line already there. Switching back then means
restoring those lines from the backup.

Show the user the diff of every file before saving, and back up `config.toml`
first.

## Claude Code on OceanToken

Claude Code talks the Anthropic Messages API, which OceanToken serves for its
Claude models. For one project, put this in `.claude/settings.local.json`
(git-ignored); for every project, in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.oceantoken.ai",
    "ANTHROPIC_AUTH_TOKEN": "<the user's OceanToken key>",
    "ANTHROPIC_MODEL": "anthropic/claude-sonnet-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5"
  }
}
```

Use model ids exactly as `search_models` returns them. Verify with
`claude -p "Reply with the single word OK"`. Settings files hold the key in
plain text: prefer the project-local file, keep it out of git, and tell the user
where it is.

## An application calling OceanToken

OpenAI SDKs need only the base URL and key:

```python
import os
from openai import OpenAI
client = OpenAI(base_url="https://api.oceantoken.ai/v1", api_key=os.environ["OCEANTOKEN_API_KEY"])
client.chat.completions.create(model="openai/gpt-5-mini", messages=[{"role": "user", "content": "Hi"}])
```

Anthropic SDKs: `Anthropic(base_url="https://api.oceantoken.ai", api_key=...)`
with a Claude model id. Read the key from the environment; never hard-code it.

## Errors

| Status | Meaning | Fix |
|---|---|---|
| 401 | Missing, wrong, expired or deleted key | Check the header; create a new key |
| 403 | Key not allowed that model | Use a model from `GET /v1/models` |
| 400 "budget exceeded" | Balance or the key's credit limit reached | Add credit in the OceanToken console or raise the key limit |
| 404 | Unknown model | Check the id with `search_models` |
| 429 | Rate limited | Back off and retry |
| 5xx | Provider failure (not charged) | Retry once, then switch model |
