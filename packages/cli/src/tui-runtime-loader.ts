import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { runTui } from "@zcode/tui";

declare const __CLI_VERSION__: string;

type TuiRuntimeModule = {
  runTui: typeof runTui;
};

type SeaModule = typeof import("node:sea");

type SeaTuiRuntimeFile = {
  mode?: number;
  path: string;
  sha256: string;
};

type SeaTuiRuntimeManifest = {
  files: SeaTuiRuntimeFile[];
  hash: string;
  target: string;
  version: 1;
};

const assetPrefix = "zcode-tui-runtime/";
const manifestAssetKey = `${assetPrefix}manifest.json`;
const packageEntryPath = "node_modules/@zcode/tui/dist/index.js";
const manifestFileName = "manifest.json";

export const loadTuiRuntime = async (): Promise<TuiRuntimeModule> => {
  // node:sea 只存在于 Node 单文件可执行构建；Bun 没有该内置模块，按非 SEA 处理。
  const sea = process.getBuiltinModule?.("node:sea") as SeaModule | undefined;

  if (!sea || !sea.isSea()) {
    // bun --compile 二进制是密封的：动态 import 磁盘上的 TUI 入口时，入口的
    // bare 依赖只查内嵌模块图，不查磁盘 node_modules，Bun.plugin 也接不到。
    // 唯一出路是让二进制以 Bun CLI 的身份（BUN_BE_BUN=1）重新执行随包发布的
    // dist/zcode.cjs：那是磁盘上的普通文件，子进程里所有解析走正常规则。
    if (isBunStandaloneExecutable()) {
      await reexecThroughBunCli();
    }
    return await import("@zcode/tui");
  }

  const runtimeDirectory = await ensureSeaTuiRuntime(sea);
  return await import(pathToFileURL(join(runtimeDirectory, packageEntryPath)).href);
};

const isBunStandaloneExecutable = (): boolean =>
  (process.argv[1] ?? "").includes("$bunfs");

const reexecThroughBunCli = async (): Promise<void> => {
  if (process.env["ZH_TUI_REEXEC"] === "1") return; // recursion guard

  // 从真实可执行位置向上找随包发布的 bundle：<install root>/dist/zcode.cjs。
  let anchor = dirname(process.execPath);
  let bundleEntry: string | undefined;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(anchor, "dist", "zcode.cjs");
    if (existsSync(candidate)) {
      bundleEntry = candidate;
      break;
    }
    const parent = dirname(anchor);
    if (parent === anchor) break;
    anchor = parent;
  }
  if (!bundleEntry) {
    throw new Error(
      "Interactive TUI needs dist/zcode.cjs next to this executable (reinstall to get it).",
    );
  }

  type BunCliSpawn = (options: {
    cmd: string[];
    env: Record<string, string | undefined>;
    stdio: ["inherit", "inherit", "inherit"];
  }) => { exited: Promise<number> };
  const bun = (globalThis as { Bun?: { spawn?: BunCliSpawn } }).Bun;
  if (!bun?.spawn) throw new Error("Bun.spawn unavailable for TUI re-exec");
  const child = bun.spawn({
    cmd: [process.execPath, "run", bundleEntry, ...process.argv.slice(2)],
    env: { ...process.env, BUN_BE_BUN: "1", ZH_TUI_REEXEC: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await child.exited);
};

const ensureSeaTuiRuntime = async (sea: SeaModule): Promise<string> => {
  const manifest = readManifest(sea);
  const cacheDirectory = join(
    cacheBaseDirectory(),
    __CLI_VERSION__,
    manifest.target,
    manifest.hash,
  );
  const markerPath = join(cacheDirectory, manifestFileName);

  if (await isCacheCurrent(markerPath, manifest)) {
    return cacheDirectory;
  }

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(temporaryDirectory, {
    recursive: true,
  });

  for (const file of manifest.files) {
    const asset = sea.getRawAsset(`${assetPrefix}${file.path}`);
    const bytes = Buffer.from(asset);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== file.sha256) {
      throw new Error(`SEA TUI asset hash mismatch for ${file.path}`);
    }

    const outputPath = join(temporaryDirectory, file.path);
    await mkdir(dirname(outputPath), {
      recursive: true,
    });
    await writeFile(outputPath, bytes);
    await chmod(outputPath, file.mode ?? modeForPath(file.path));
  }

  await writeFile(markerPathForDirectory(temporaryDirectory), JSON.stringify(manifest, null, 2));
  await rm(cacheDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(dirname(cacheDirectory), {
    recursive: true,
  });
  await rename(temporaryDirectory, cacheDirectory);
  return cacheDirectory;
};

const readManifest = (sea: SeaModule): SeaTuiRuntimeManifest => {
  const raw = sea.getAsset(manifestAssetKey, "utf8");
  const manifest = JSON.parse(raw) as SeaTuiRuntimeManifest;
  if (manifest.version !== 1 || !manifest.hash || !Array.isArray(manifest.files)) {
    throw new Error("Invalid SEA TUI runtime manifest.");
  }
  return manifest;
};

const isCacheCurrent = async (
  markerPath: string,
  expected: SeaTuiRuntimeManifest,
): Promise<boolean> => {
  if (!existsSync(markerPath)) return false;

  try {
    const current = JSON.parse(await readFile(markerPath, "utf8")) as SeaTuiRuntimeManifest;
    return current.hash === expected.hash && current.target === expected.target;
  } catch {
    return false;
  }
};

const cacheBaseDirectory = (): string => {
  const home = homedir();
  if (platform() === "darwin" && home) {
    return join(home, "Library", "Caches", "zcode", "sea-assets");
  }
  if (platform() === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(home || tmpdir(), "AppData", "Local"),
      "zcode",
      "Cache",
      "sea-assets",
    );
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(home || tmpdir(), ".cache"),
    "zcode",
    "sea-assets",
  );
};

const markerPathForDirectory = (directory: string): string => join(directory, manifestFileName);

const modeForPath = (filePath: string): number =>
  /\.(?:dll|dylib|node|so)$/i.test(filePath) ? 0o755 : 0o644;
