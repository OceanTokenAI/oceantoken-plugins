// Copy the plugin's skills into the package before `npm pack`/`npm publish`, so the CLI
// ships exactly the skills the Codex/Claude/Cursor plugin ships.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../../plugins/oceantoken/skills", import.meta.url));
const dst = fileURLToPath(new URL("../skills", import.meta.url));
const license = fileURLToPath(new URL("../../LICENSE", import.meta.url));

fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
fs.copyFileSync(license, fileURLToPath(new URL("../LICENSE", import.meta.url)));
console.log(`synced ${fs.readdirSync(dst).join(", ")} into cli/skills`);
