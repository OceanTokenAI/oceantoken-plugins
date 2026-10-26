# Install OceanToken in this agent

This page is for an AI agent that a user asked to install or update OceanToken.
OceanToken is one account for 500+ AI models (chat, image, video, speech,
transcription). Installing it adds the OceanToken MCP server
(`https://mcp.oceantoken.ai/mcp`) and three skills to the agent the user is
talking to. Follow these steps in order.

## 1. Identify the host

Work out which client you are running in. If you cannot tell, ask the user;
do not pick one because it happens to be installed on the machine.

## 2. Run exactly one command for that host

```sh
npx -y @oceantoken/cli@latest connect codex        # Codex (CLI or app)
npx -y @oceantoken/cli@latest connect claude-code  # Claude Code: terminal, IDE extension or the Claude desktop app
npx -y @oceantoken/cli@latest connect cursor       # Cursor
npx -y @oceantoken/cli@latest connect gemini       # Gemini CLI
npx -y @oceantoken/cli@latest connect openclaw     # OpenClaw
npx -y @oceantoken/cli@latest connect opencode     # OpenCode
npx -y @oceantoken/cli@latest connect vscode       # VS Code with GitHub Copilot
npx -y @oceantoken/cli@latest connect workbuddy    # WorkBuddy
npx -y @oceantoken/cli@latest connect hermes       # Hermes Agent
npx -y @oceantoken/cli@latest connect windsurf     # Windsurf / Devin Desktop
```

- It needs Node.js 18.17 or newer, network access, and write access to the
  user's home directory (the host's config and skills folders). If your
  sandbox blocks any of that, ask the user to approve running the command
  outside the sandbox.
- Running it again is safe: it updates the plugin or entry in place.
- Do not run it for other hosts the user did not ask about. Each host signs in
  separately.
- If your host's permission system blocks the command (Claude Code's auto mode
  can, since it downloads a package and changes the host's configuration), do
  not retry it another way or work around the check. Tell the user, and offer
  these in order:
  1. Approve it: switch the session to a mode that asks before running
     commands, then ask you again and allow the command when asked.
  2. Run it themselves in a terminal:
     `npx -y @oceantoken/cli@latest connect <host>`.
  3. The host's own route.
     - **Claude Code**: type `/plugin marketplace add OceanTokenAI/oceantoken-plugins`,
       then `/plugin install oceantoken@oceantoken`, then `/mcp`, choose
       `plugin:oceantoken:oceantoken` and select Authenticate.
     - **Claude desktop app or claude.ai**: Settings → Connectors → Add custom
       connector, URL `https://mcp.oceantoken.ai/mcp`, then Connect. If an
       OceanToken connector is already there but its tools fail, disconnect it
       and connect again.

## 3. Let the user sign in

Sign-in is OAuth by default. The user signs in with their OceanToken account
(or pastes an existing API key on the sign-in page). New users can create an
account from the same page.

- **Codex, Claude Code, OpenClaw, OpenCode, Hermes:** the command starts the
  host's own sign-in, opens the browser and waits. Tell the user a browser
  window is waiting for them, then wait for the command to finish (it can take
  a few minutes; do not cancel it).
- **Gemini CLI, Cursor, VS Code, WorkBuddy, Windsurf:** sign-in happens inside
  the app after the command finishes. Relay the "Next" line of the report to
  the user.

Do not open the authorization URL yourself, drive the browser, call OAuth
endpoints, or start a second sign-in while one is waiting.

## 4. Use an API key only as a fallback

Only when OAuth is not possible, or the user asks for a key: ask them to
create one at https://app.oceantoken.ai/ui/?page=api-keys&utm_source=oceantoken-plugins&utm_medium=readme and hand it to you
through a secure input. Pass it on stdin so it stays out of the command line:

```sh
printf %s "$OCEANTOKEN_API_KEY" | npx -y @oceantoken/cli@latest connect <host> --api-key -
```

Never print, log or repeat the key, and never put it in your report. If the
command says the key was rejected, ask the user for a new one; do not switch to
OAuth without telling them.

## 5. Report

The command ends with a summary. Report its lines as they are: client, auth,
MCP, skills, sign-in, restart, result, and every "Next" item. Say the install
worked only when `Result` is `connected`; for `incomplete`, list what the user
still has to do.

Do not run a generation or any other paid call as a test. Close with one
sentence: OceanToken can now find and price models, generate images, video,
voice-overs and subtitles, and hand work to other models, billed to the user's
OceanToken balance. Then remind the user to restart the session if the report
says so, and ask what they would like to make first.

## Removing it

```sh
npx -y @oceantoken/cli@latest disconnect <host>
```

Manual setup for every host: https://github.com/OceanTokenAI/oceantoken-plugins#install
