import { MARKER } from "../constants.js";

// `use codex` makes OceanToken the model provider in ~/.codex/config.toml. Like the
// MCP block, the file is edited as text, never parsed: the CLI adds two marked blocks
// and, because TOML forbids a key twice, comments out the user's own top-level
// `model` / `model_provider` lines with a prefix it can find again on revert.
//
//   # OceanToken model provider (added by @oceantoken/cli)   <- before the first table
//   model_provider = "oceantoken"
//   model = "openai/gpt-5.5"
//   # end OceanToken model provider
//   ...
//   # OceanToken provider table (added by @oceantoken/cli)   <- at the end
//   [model_providers.oceantoken]
//   ...
//   # end OceanToken provider table
//
// Codex 0.154 rejects a top-level `profile = ...`, so the keys go at the top level.

export const PROVIDER_ID = "oceantoken";
const TOP_BEGIN = `# OceanToken model provider (${MARKER})`;
const TOP_END = "# end OceanToken model provider";
const TABLE_BEGIN = `# OceanToken provider table (${MARKER})`;
const TABLE_END = "# end OceanToken provider table";
const DISABLED = "# disabled by @oceantoken/cli: ";
const TOP_KEYS = /^\s*(model_provider|model)\s*=/;
const CATALOG_KEY = /^\s*model_catalog_json\s*=/;
const TABLE_HEADER = /^\s*\[/;

const tomlString = (s) => JSON.stringify(s);

// The ChatGPT desktop app rewrites config.toml while it runs, and a comment that sits right
// before a table belongs to that table for its TOML writer: the end markers below are lost
// when the app rewrites the table that follows them (seen on a real config, 2026-10-20). So
// a block whose end marker is gone still ends where the CLI's own lines end.

/** Lines of the top block: our model_provider / model keys after the begin marker. */
function topBlockEnd(lines, start) {
  let i = start + 1;
  const ours = { model_provider: false, model: false, model_catalog_json: false };
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === TOP_END) return i;
    const m = /^(model_provider|model_catalog_json|model)\s*=/.exec(t);
    if (!m || ours[m[1]]) break;
    ours[m[1]] = true;
  }
  return i - 1;
}

/** Lines of the table block: the [model_providers.oceantoken] table after the begin marker. */
function tableBlockEnd(lines, start) {
  let i = start + 1;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === TABLE_END) return i;
    if (i > start + 1 && TABLE_HEADER.test(lines[i])) break;
  }
  let end = i - 1;
  while (end > start && lines[end].trim() === "") end--;
  return end;
}

function cutBlock(lines, begin, blockEnd) {
  const start = lines.findIndex((l) => l.trim() === begin);
  if (start < 0) return false;
  lines.splice(start, blockEnd(lines, start) - start + 1);
  return true;
}

// A parked `model_provider = "oceantoken"` can only be this CLI's own line that lost its
// marker; bringing it back would point Codex at a provider `unuse` has removed.
const OUR_PROVIDER_LINE = new RegExp(`^\\s*model_provider\\s*=\\s*"${PROVIDER_ID}"\\s*(#.*)?$`);

const tidy = (lines) => `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s*$/, "")}\n`;

/**
 * Point Codex at OceanToken. `auth` is { headers } to keep the key in the file, or
 * { envKey } to have Codex read it from an environment variable. `catalog` is the path of
 * a model list for Codex's picker (model_catalog_json), or nothing.
 * Returns { status: created | added | updated | unchanged | manual, text?, reason? }.
 */
export function applyCodexProvider(text, { baseUrl, model, auth, catalog }) {
  const lines = (text ?? "").split("\n");
  cutBlock(lines, TOP_BEGIN, topBlockEnd);
  cutBlock(lines, TABLE_BEGIN, tableBlockEnd);
  const handWritten = new RegExp(`^\\s*\\[model_providers\\.(${PROVIDER_ID}|"${PROVIDER_ID}")\\]`);
  if (lines.some((l) => handWritten.test(l))) {
    return { status: "manual", reason: `config.toml already has a hand-written [model_providers.${PROVIDER_ID}] table` };
  }
  let firstTable = lines.findIndex((l) => TABLE_HEADER.test(l));
  if (firstTable < 0) firstTable = lines.length;
  for (let i = firstTable - 1; i >= 0; i--) {
    if (OUR_PROVIDER_LINE.test(lines[i])) lines.splice(i, 1);
    else if (TOP_KEYS.test(lines[i]) || (catalog && CATALOG_KEY.test(lines[i]))) lines[i] = `${DISABLED}${lines[i]}`;
  }
  firstTable = lines.findIndex((l) => TABLE_HEADER.test(l));
  if (firstTable < 0) firstTable = lines.length;
  const top = [TOP_BEGIN, `model_provider = ${tomlString(PROVIDER_ID)}`, `model = ${tomlString(model)}`];
  if (catalog) top.push(`model_catalog_json = ${tomlString(catalog)}`);
  top.push(TOP_END, "");
  lines.splice(firstTable, 0, ...top);

  const table = [TABLE_BEGIN, `[model_providers.${PROVIDER_ID}]`, 'name = "OceanToken"', `base_url = ${tomlString(baseUrl)}`, 'wire_api = "responses"'];
  if (auth.envKey) table.push(`env_key = ${tomlString(auth.envKey)}`);
  else {
    const pairs = Object.entries(auth.headers).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`);
    table.push(`http_headers = { ${pairs.join(", ")} }`);
  }
  table.push(TABLE_END);
  const out = tidy([...lines, "", ...table]);
  if (text === null || text === undefined) return { status: "created", text: out };
  if (out === tidy(text.split("\n"))) return { status: "unchanged", text };
  return { status: text.includes(TOP_BEGIN) ? "updated" : "added", text: out };
}

/** Undo applyCodexProvider: drop both blocks and bring back the lines it commented out. */
export function revertCodexProvider(text) {
  if (!text) return { status: "absent", text };
  const lines = text.split("\n");
  const top = cutBlock(lines, TOP_BEGIN, topBlockEnd);
  const table = cutBlock(lines, TABLE_BEGIN, tableBlockEnd);
  let restored = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(DISABLED)) continue;
    const line = lines[i].slice(DISABLED.length);
    if (OUR_PROVIDER_LINE.test(line)) lines.splice(i, 1);
    else lines[i] = line;
    restored = true;
  }
  if (!top && !table && !restored) return { status: "absent", text };
  return { status: "removed", text: tidy(lines) };
}

/** Whether config.toml currently routes Codex through OceanToken. */
export const codexUsesOceanToken = (text) => Boolean(text?.includes(TOP_BEGIN));

/**
 * The API key an earlier `use codex` stored in its provider table, or null. A rerun of
 * `use codex` (for instance to add the tools) then needs no key pasted again.
 */
export function codexProviderKey(text) {
  const lines = (text ?? "").split("\n");
  const start = lines.findIndex((l) => l.trim() === TABLE_BEGIN);
  if (start < 0) return null;
  for (const line of lines.slice(start, tableBlockEnd(lines, start) + 1)) {
    const m = /^\s*http_headers\s*=.*"Authorization"\s*=\s*"Bearer (sk-[A-Za-z0-9_-]+)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}
