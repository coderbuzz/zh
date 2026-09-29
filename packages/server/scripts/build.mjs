// Bun.build replacement for the upstream tsup build of @zcode/server.
// Produces dist/entry-http.js only: the remote single-file bundle
// (upstream build-remote.ts) is not part of zh web mode. Run with bun:
//   bun packages/server/scripts/build.mjs
import { cp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const serverRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(serverRoot, "../..");
const outDir = resolve(serverRoot, "dist");

const { version } = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const zcodeEnv = process.env.ZCODE_ENV?.trim().toLowerCase() || "test";
const builtinProviderConfigJson = JSON.stringify(
  await readFile(resolve(repoRoot, "config/provider/zcode-builtin.json"), "utf8"),
);

// Keep node-pty/ssh2 (native addons) and CJS-heavy packages external; the
// release asset ships them as a runtime node_modules tree staged next to the
// bundle by scripts/stage-server-runtime.mjs.
const externalDependencies = [
  "ssh2",
  "node-pty",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "proxy-from-env",
  "follow-redirects",
  "node-forge",
  "yaml",
  "yazl",
  "yauzl",
];

const result = await Bun.build({
  entrypoints: [resolve(serverRoot, "src/entry-http.ts")],
  outdir: outDir,
  naming: { entry: "entry-http.js" },
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  define: {
    __ZCODE_VERSION__: JSON.stringify(version),
    __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: builtinProviderConfigJson,
  },
  external: externalDependencies,
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  throw new Error("bun server build failed");
}

await cp(resolve(repoRoot, "THIRD-PARTY-NOTICES.md"), resolve(outDir, "THIRD-PARTY-NOTICES.md"));
console.log("zh server build done -> dist/entry-http.js");
