import claudeCode from "./claude-code.js";
import codex from "./codex.js";
import { cursor, hermes, opencode, vscode, windsurf, workbuddy } from "./files.js";
import gemini from "./gemini.js";
import openclaw from "./openclaw.js";

export const CLIENTS = [codex, claudeCode, cursor, gemini, openclaw, opencode, vscode, workbuddy, hermes, windsurf];

export function findClient(name) {
  const key = String(name || "").trim().toLowerCase();
  return CLIENTS.find((c) => c.id === key || c.aliases.includes(key)) ?? null;
}
