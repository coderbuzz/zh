import { chmod, readFile, rm } from "node:fs/promises";
import { stageThirdPartyNotices, readThirdPartyNotices } from "./third-party-notices.mjs";
import { stageBuiltinProviderConfig } from "./builtin-provider-config.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cliRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(cliRoot, "../..");
const executableFileMode = 0o755;
const rootPackageVersionError = "Root package.json must define a non-empty string version.";

// playwright-core stays external: it reads files from its own package tree at
// runtime (bundling it breaks; it ships as a release asset instead). koffi
// dynamically requires native .node files per platform; @zcode/tui is not part
// of this repository.
const buildExternal = () => ["@zcode/tui", "playwright-core", "koffi"];

// Releases inject the tag (ZCODE_BUILD_VERSION) so `zh version` always matches
// the published release; source builds fall back to the root package.json.
export const resolveCliVersion = async (env = process.env) => {
  const override = env.ZCODE_BUILD_VERSION?.trim();
  if (override) return override;
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error(rootPackageVersionError);
  }
  return packageJson.version;
};

export const resolveBuildOptions = (args = [], env = process.env) => {
  // --release means "ship it": minified, no sourcemap. E2E coverage builds
  // must keep raw symbols + source map for c8 to map back to TS sources.
  const release = args.includes("--release") || args.includes("--minify");
  const e2eCoverage = env.ZCODE_E2E_COVERAGE === "1";
  return {
    minify: release && !e2eCoverage,
    sourcemap: e2eCoverage || !release,
  };
};

export const buildCli = async ({
  minify = false,
  sourcemap = true,
  env = process.env,
  version,
} = {}) => {
  const cliVersion = version ?? (await resolveCliVersion(env));
  const outfile = resolve(cliRoot, "dist/zcode.cjs");
  const sourcemapFile = `${outfile}.map`;
  const notices = await readThirdPartyNotices(projectRoot);

  await stageBuiltinProviderConfig({
    root: projectRoot,
    directory: resolve(cliRoot, "dist/provider"),
    env,
  });

  // Bun.build ignores outfile when no outdir is given; outdir + a literal
  // entry name writes dist/zcode.cjs (and .map) directly with correct names.
  const result = await Bun.build({
    entrypoints: [resolve(cliRoot, "src/main.ts")],
    outdir: resolve(cliRoot, "dist"),
    naming: { entry: "zcode.cjs" },
    // 产物在发布资产里由 node >= 22 或 bun 运行，运行时兼容面以两者交集为准。
    target: "node",
    format: "cjs",
    minify,
    sourcemap: sourcemap ? "linked" : "none",
    define: { __CLI_VERSION__: JSON.stringify(cliVersion) },
    external: buildExternal(),
    // SEA 与普通 CLI 共用入口；--licenses 必须在 Agent 初始化前短路退出。
    // node:sea 只在 Node 存在；Bun 等运行时没有该模块，licenses 路径按非 SEA 处理。
    banner: `#!/usr/bin/env node\n"use strict";\nif (process.argv.length === 3 && process.argv[2] === "--licenses") { let sea = null; try { sea = require("node:sea"); } catch {} const nodeNotice = sea && sea.isSea() ? "\\n\\n## Bundled Node.js runtime\\n\\n" + sea.getAsset("zcode-node-license", "utf8") : ""; process.stdout.write(${JSON.stringify(notices.toString("utf8"))} + nodeNotice, () => process.exit(0)); } else {`,
    footer: "}",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("bun build failed");
  }

  if (!sourcemap) await rm(sourcemapFile, { force: true });
  await chmod(outfile, executableFileMode);
  await stageThirdPartyNotices(resolve(cliRoot, "dist"), projectRoot);
  return result;
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { minify, sourcemap } = resolveBuildOptions(process.argv.slice(2));
  await buildCli({ minify, sourcemap });
}
