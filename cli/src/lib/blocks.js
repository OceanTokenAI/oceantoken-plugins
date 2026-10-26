import { MARKER, SERVER_NAME } from "../constants.js";

// Codex's config.toml and Hermes' config.yaml are edited as text, not parsed: the CLI
// only ever adds or removes one block it wrapped in marker comments, and refuses to
// touch a server entry the user wrote by hand.

const BEGIN = `# OceanToken MCP server (${MARKER})`;
const END = "# end OceanToken";

const tomlString = (s) => JSON.stringify(s);

/**
 * The Codex `[mcp_servers.oceantoken]` table, wrapped in markers. `bearerEnv` names an
 * environment variable Codex reads the API key from, instead of a key in the file.
 */
export function codexBlock(url, headers, { bearerEnv } = {}) {
  const lines = [BEGIN, `[mcp_servers.${SERVER_NAME}]`, `url = ${tomlString(url)}`];
  if (headers) {
    const pairs = Object.entries(headers).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`);
    lines.push(`http_headers = { ${pairs.join(", ")} }`);
  } else if (bearerEnv) {
    lines.push(`bearer_token_env_var = ${tomlString(bearerEnv)}`);
  }
  lines.push(END);
  return lines.join("\n");
}

/** Whether config.toml already holds the OceanToken block this CLI writes. */
export const hasCodexBlock = (text) => findBlock((text ?? "").split("\n")) !== null;

// The note `use codex` adds to Codex's own AGENTS.md (its global instructions), so Codex
// reaches for OceanToken's tools when asked for images, video or audio. HTML comments
// mark it, so `unuse` removes exactly this note and nothing the user wrote.
const NOTE_BEGIN = `<!-- OceanToken (${MARKER}; \`unuse codex\` removes it) -->`;
const NOTE_END = "<!-- end OceanToken -->";

/** Insert or replace the marked note in AGENTS.md text. */
export function upsertMarkdownNote(text, body) {
  const block = [NOTE_BEGIN, body.trim(), NOTE_END].join("\n");
  const lines = (text ?? "").split("\n");
  const start = lines.findIndex((l) => l.trim() === NOTE_BEGIN);
  const stop = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === NOTE_END);
  if (start >= 0 && stop >= 0) {
    if (lines.slice(start, stop + 1).join("\n") === block) return { status: "unchanged", text };
    lines.splice(start, stop - start + 1, ...block.split("\n"));
    return { status: "updated", text: lines.join("\n") };
  }
  const base = (text ?? "").replace(/\s*$/, "");
  return { status: text ? "added" : "created", text: `${base ? `${base}\n\n` : ""}${block}\n` };
}

/** Remove the marked note from AGENTS.md text, leaving the rest as it was. */
export function removeMarkdownNote(text) {
  if (!text) return { status: "absent", text };
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === NOTE_BEGIN);
  const stop = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === NOTE_END);
  if (start < 0 || stop < 0) return { status: "absent", text };
  lines.splice(start, stop - start + 1);
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s*$/, "");
  return { status: "removed", text: out ? `${out}\n` : "" };
}

function findBlock(lines) {
  const start = lines.findIndex((l) => l.trim() === BEGIN);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === END);
  if (end >= 0 && !lines.slice(start + 2, end).some((l) => /^\s*\[/.test(l))) return { start, end };
  // The ChatGPT app rewrites config.toml and can drop the end marker (a comment before the
  // next table belongs to that table): the TOML block then ends with its own table.
  if (!/^\s*\[mcp_servers\./.test(lines[start + 1] ?? "")) return end < 0 ? null : { start, end };
  let stop = start + 2;
  while (stop < lines.length && !/^\s*\[/.test(lines[stop]) && lines[stop].trim() !== END) stop++;
  if (lines[stop]?.trim() === END) return { start, end: stop };
  stop -= 1;
  while (stop > start && lines[stop].trim() === "") stop--;
  return { start, end: stop };
}

/** Insert or replace the marked block in config.toml text. */
export function upsertCodexBlock(text, block) {
  const lines = (text ?? "").split("\n");
  const found = findBlock(lines);
  if (found) {
    const current = lines.slice(found.start, found.end + 1).join("\n");
    if (current === block) return { status: "unchanged", text };
    lines.splice(found.start, found.end - found.start + 1, ...block.split("\n"));
    return { status: "updated", text: lines.join("\n") };
  }
  const handWritten = new RegExp(`^\\s*\\[mcp_servers\\.(${SERVER_NAME}|"${SERVER_NAME}")\\]\\s*(#.*)?$`, "m");
  if (handWritten.test(text ?? "")) {
    return { status: "manual", reason: `config.toml already has a hand-written [mcp_servers.${SERVER_NAME}] table` };
  }
  const base = (text ?? "").replace(/\s*$/, "");
  return { status: text ? "added" : "created", text: `${base ? `${base}\n\n` : ""}${block}\n` };
}

/** Remove the marked block from config.toml or config.yaml text. */
export function removeBlock(text) {
  if (!text) return { status: "absent", text };
  const lines = text.split("\n");
  const found = findBlock(lines);
  if (!found) return { status: "absent", text };
  lines.splice(found.start, found.end - found.start + 1);
  return { status: "removed", text: lines.join("\n").replace(/\n{3,}/g, "\n\n") };
}

/** The Hermes `mcp_servers.oceantoken` entry, indented under mcp_servers and wrapped in markers. */
export function hermesBlock(indent, url, headers) {
  const pad = " ".repeat(indent);
  const lines = [`${pad}${BEGIN}`, `${pad}${SERVER_NAME}:`, `${pad}${pad}url: ${JSON.stringify(url)}`];
  if (headers) {
    lines.push(`${pad}${pad}headers:`);
    for (const [k, v] of Object.entries(headers)) lines.push(`${pad}${pad}${pad}${k}: ${JSON.stringify(v)}`);
  } else {
    lines.push(`${pad}${pad}auth: oauth`);
  }
  lines.push(`${pad}${END}`);
  return lines;
}

/** Insert or replace the OceanToken server under the top-level `mcp_servers:` mapping of config.yaml. */
export function upsertHermesServer(text, url, headers) {
  const lines = (text ?? "").split("\n");
  if (lines.some((l) => /^\t/.test(l))) return { status: "manual", reason: "config.yaml is indented with tabs" };
  const found = findBlock(lines);
  if (found) {
    const indent = lines[found.start].match(/^ */)[0].length;
    const block = hermesBlock(indent, url, headers);
    if (lines.slice(found.start, found.end + 1).join("\n") === block.join("\n")) return { status: "unchanged", text };
    lines.splice(found.start, found.end - found.start + 1, ...block);
    return { status: "updated", text: lines.join("\n") };
  }
  const header = lines.findIndex((l) => /^mcp_servers:\s*(#.*)?$/.test(l));
  if (header < 0) {
    if (lines.some((l) => /^mcp_servers:/.test(l))) {
      return { status: "manual", reason: "mcp_servers in config.yaml is written inline" };
    }
    const base = (text ?? "").replace(/\s*$/, "");
    const block = ["mcp_servers:", ...hermesBlock(2, url, headers)].join("\n");
    return { status: text ? "added" : "created", text: `${base ? `${base}\n\n` : ""}${block}\n` };
  }
  // The mapping's children share the first child's indent; it ends at the next unindented line.
  const content = (l) => l.trim() !== "" && !l.trim().startsWith("#");
  const lead = (l) => l.match(/^ */)[0].length;
  const firstChild = lines.findIndex((l, i) => i > header && content(l));
  const indent = firstChild > 0 && lead(lines[firstChild]) > 0 ? lead(lines[firstChild]) : 2;
  let end = lines.findIndex((l, i) => i > header && content(l) && lead(l) === 0);
  if (end < 0) end = lines.length;
  const existing = new RegExp(`^ {${indent}}["']?${SERVER_NAME}["']?\\s*:`);
  if (lines.slice(header + 1, end).some((l) => existing.test(l))) {
    return { status: "manual", reason: `config.yaml already has a hand-written ${SERVER_NAME} server` };
  }
  lines.splice(header + 1, 0, ...hermesBlock(indent, url, headers));
  return { status: "added", text: lines.join("\n") };
}
