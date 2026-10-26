import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER, SKILL_NAMES } from "../constants.js";
import { copyDir, exists, readIfExists, removeDir } from "./fsutil.js";

export const OWNER_FILE = ".oceantoken-cli";

/** The skills shipped in the package (synced from plugins/oceantoken/skills when packed). */
export function bundledSkillsDir() {
  const packaged = fileURLToPath(new URL("../../skills", import.meta.url));
  if (exists(path.join(packaged, SKILL_NAMES[0], "SKILL.md"))) return packaged;
  // Running from a checkout of the plugins repo.
  return fileURLToPath(new URL("../../../plugins/oceantoken/skills", import.meta.url));
}

/**
 * Copy the OceanToken skills into a host's skills directory.
 * A folder of the same name that this CLI did not install is left alone.
 */
export function installSkills(targetDir, { dryRun = false } = {}) {
  const source = bundledSkillsDir();
  const installed = [];
  const skipped = [];
  for (const name of SKILL_NAMES) {
    const dst = path.join(targetDir, name);
    if (exists(dst) && !exists(path.join(dst, OWNER_FILE))) {
      skipped.push(name);
      continue;
    }
    if (!dryRun) {
      removeDir(dst);
      // agents/openai.yaml is Codex plugin metadata; other hosts do not read it.
      copyDir(path.join(source, name), dst, { skip: ["agents"] });
      fs.writeFileSync(path.join(dst, OWNER_FILE), `${MARKER}\n`);
    }
    installed.push(name);
  }
  return { installed, skipped };
}

/** Remove the skills this CLI installed from a host's skills directory (only `names`, when given). */
export function removeSkills(targetDir, { dryRun = false, names = SKILL_NAMES } = {}) {
  const removed = [];
  for (const name of SKILL_NAMES.filter((n) => names.includes(n))) {
    const dst = path.join(targetDir, name);
    if (readIfExists(path.join(dst, OWNER_FILE)) === null) continue;
    if (!dryRun) removeDir(dst);
    removed.push(name);
  }
  return { removed };
}
