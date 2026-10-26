import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The model list Codex's picker shows comes from its model catalog, which names ChatGPT's
// models (gpt-6-luna). On OceanToken those are openai/gpt-6-luna. Codex (checked on 0.163,
// the ChatGPT desktop app's engine) reads a replacement catalog from the file that the
// top-level config key `model_catalog_json` names: `{ "models": [ ... ] }`, the same shape
// `codex debug models` prints. `use codex` writes one built from the catalog of the user's
// own Codex, with every model OceanToken offers under OceanToken's id and the same settings,
// so the picker shows ids that work and Codex keeps each model's tuning.
//
// Codex refuses to start a chat when that file is missing or does not parse, so the file is
// written before config.toml names it, and `unuse` removes the config line before the file.

/** The engines of the desktop apps, which may not be on PATH (macOS). */
export const APP_ENGINES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  path.join(os.homedir(), "Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
  "/Applications/Codex.app/Contents/Resources/codex",
];

export const CATALOG_FILE = "oceantoken-models.json";

/**
 * The catalog shipped with the user's Codex, as { engine, models }, or null. The desktop
 * app's engine wins over a `codex` on PATH: the app is what reads the file. It runs with an
 * empty CODEX_HOME so that no earlier catalog or setting changes what it prints.
 */
export async function bundledCatalog(ctx, { engines = ctx.appEngines ?? APP_ENGINES, exists = fs.existsSync } = {}) {
  const candidates = [...engines.filter((e) => exists(e)), ...(ctx.which("codex") ? ["codex"] : [])];
  if (!candidates.length) return null;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oceantoken-codex-"));
  try {
    for (const engine of candidates) {
      const res = await ctx.probe(engine, ["debug", "models", "--bundled"], { env: { ...ctx.env, CODEX_HOME: scratch } });
      if (res.code !== 0) continue;
      try {
        const parsed = JSON.parse(res.stdout);
        if (Array.isArray(parsed?.models) && parsed.models.length) return { engine, models: parsed.models };
      } catch {
        // not a catalog; try the next engine
      }
    }
    return null;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * OceanToken's catalog: each listed model OceanToken offers, under its OceanToken id, plus
 * the original entries hidden from the picker (a chat still on the ChatGPT plan keeps its
 * model's settings). `available` is the set of ids the key can use, or null (then gpt-*).
 * Returns null when OceanToken offers none of them.
 */
export function oceanTokenCatalog(models, available) {
  const offered = (id) => (available ? available.has(id) : /^openai\/gpt-/.test(id));
  const ours = [];
  for (const m of models) {
    if (!m || typeof m.slug !== "string" || m.slug.includes("/") || m.visibility !== "list") continue;
    const id = `openai/${m.slug}`;
    if (offered(id)) ours.push({ ...m, slug: id });
  }
  if (!ours.length) return null;
  const hidden = models.filter((m) => m && typeof m.slug === "string").map((m) => ({ ...m, visibility: "hide" }));
  return { models: [...ours, ...hidden] };
}
