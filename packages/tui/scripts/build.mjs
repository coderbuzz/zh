// Bundle the TUI entry into a single ESM file. Workspace @zcode/* packages are
// bundled in; the npm dependencies stay external because OpenTUI and its
// native/worker assets must retain their package-relative paths.
import { resolve } from "node:path";

const tuiDirectory = resolve(import.meta.dirname, "..");

const manifest = await Bun.file(resolve(tuiDirectory, "package.json")).json();
const external = Object.keys(manifest.dependencies).filter(
  (name) => !name.startsWith("@zcode/"),
);

const result = await Bun.build({
  entrypoints: [resolve(tuiDirectory, "src/index.ts")],
  outdir: resolve(tuiDirectory, "dist"),
  naming: { entry: "index.[ext]" },
  external,
  format: "esm",
  target: "node",
  sourcemap: process.argv.includes("--release") ? "none" : "external",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`tui bundle: ${result.outputs[0].path}`);
