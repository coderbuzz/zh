import { rm } from "node:fs/promises";
import { resolve } from "node:path";

// Shared by every workspace package's "clean" script. Package managers run it
// with the package directory as cwd, so targets resolve per package.
const targets = process.argv.slice(2);
for (const target of targets.length > 0 ? targets : ["dist"]) {
  await rm(resolve(process.cwd(), target), { recursive: true, force: true });
}
