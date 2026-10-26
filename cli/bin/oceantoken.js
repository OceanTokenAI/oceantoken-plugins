#!/usr/bin/env node
import { main } from "../src/cli.js";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  process.stderr.write(`@oceantoken/cli needs Node.js 18.17 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}

process.exitCode = await main();
