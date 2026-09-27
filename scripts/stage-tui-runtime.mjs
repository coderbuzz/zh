// Stage the @zcode/tui runtime dependency closure as a release asset.
//
// The TUI never enters the zh bundle or binaries: its bundle stays external
// (top-level await in OpenTUI's native loader) and ships as a tar.gz extracted
// by the installer into <install root>/node_modules, next to the
// playwright-core driver. Layout follows the upstream SEA TUI staging rules:
// no .map files, workspace packages reduced to package.json + dist, koffi
// trimmed to the build triplets we release, OpenTUI natives for all four
// release targets fetched with npm pack when the host install only provides
// its own platform.
//
// Usage: bun scripts/stage-tui-runtime.mjs [--out out/] [--tag vX.Y.Z]
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const tuiDir = resolve(repoRoot, "packages/tui");
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const koffiTriplets = targets.map((t) => t.replace("-", "_"));

const args = process.argv.slice(2);
const outArg = args.indexOf("--out") >= 0 ? args[args.indexOf("--out") + 1] : "out";
const tagArg = args.indexOf("--tag") >= 0 ? args[args.indexOf("--tag") + 1] : "";
const outDir = resolve(repoRoot, outArg);

const nativePackageForTarget = (target) => {
  const [platform, arch] = target.split("-");
  const npmPlatform = platform === "darwin" ? "darwin" : platform;
  return `@mbears/opentui-core-${npmPlatform}-${arch}`;
};

const readManifest = async (pkgDir) =>
  JSON.parse(await readFile(resolve(pkgDir, "package.json"), "utf8"));

const resolved = new Map(); // package name -> real package dir
const resolvePackageDir = (name, fromDir) => {
  if (resolved.has(name)) return resolved.get(name);
  try {
    const entry = execFileSync(
      process.execPath,
      ["-e", `console.log(require.resolve(${JSON.stringify(`${name}/package.json`)}, { paths: [${JSON.stringify(fromDir)}] }))`],
      { encoding: "utf8" },
    ).trim();
    resolved.set(name, entry);
    return entry;
  } catch {
    resolved.set(name, null);
    return null;
  }
};

const walkFiles = async function* (directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
};

// npm pack into a shared cache; the host install only carries the host
// platform's OpenTUI native package, the release asset needs all four.
const nativeCacheDir = await mkdtemp(join(tmpdir(), "tui-natives-"));
const fetchNativePackage = (name, version) => {
  const dir = join(nativeCacheDir, name);
  const marker = join(dir, ".fetched");
  if (existsSync(marker)) return join(dir, "package");
  rm(dir, { force: true, recursive: true });
  mkdir(dir, { recursive: true });
  execFileSync("npm", ["pack", `${name}@${version}`, "--silent"], { cwd: dir, stdio: "ignore" });
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  execFileSync("tar", ["-xzf", tarball, "-C", dir], { cwd: dir, stdio: "ignore" });
  rm(join(dir, tarball));
  writeFileSync(marker, "1");
  return join(dir, "package");
};

const staged = new Set(); // package names already copied
const copyPackage = async (name, sourceDir, destDir) => {
  if (staged.has(name)) return;
  staged.add(name);
  const target = join(destDir, name);
  await mkdir(dirname(target), { recursive: true });

  for await (const file of walkFiles(sourceDir)) {
    const rel = relative(sourceDir, file);
    if (rel.endsWith(".map")) continue;
    if (name === "@zcode/tui" && rel !== "package.json" && rel !== "dist/index.js" && rel !== "dist/index.d.ts") continue;
    if (name === "koffi") {
      const triplet = rel.split(sep)[2];
      const keepRootFile = ["index.d.ts", "index.js", "indirect.js", "LICENSE.txt", "package.json"].includes(rel);
      const keepTriplet = rel.startsWith(`build${sep}koffi${sep}`) && koffiTriplets.includes(triplet) && rel.endsWith("koffi.node");
      if (!keepRootFile && !keepTriplet) continue;
    }
    const dest = join(target, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(file, dest);
  }
};

const staging = await mkdtemp(join(tmpdir(), "tui-stage-"));
const destModules = join(staging, "node_modules");
const queue = [{ name: "@zcode/tui", dir: tuiDir }];

while (queue.length > 0) {
  const { name, dir } = queue.shift();
  await copyPackage(name, dir, destModules);
  const manifest = await readManifest(join(destModules, name));
  // The tui bundle already contains the @zcode/* workspace code, so only its
  // npm dependencies form the runtime closure.
  const deps = Object.fromEntries(
    Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter(
      ([dep]) => !(name.startsWith("@zcode/") ? dep.startsWith("@zcode/") : false),
    ),
  );
  for (const [dep, range] of Object.entries(deps)) {
    if (dep.startsWith("@types/") || dep.startsWith("@zcode/")) continue;
    if (!staged.has(dep)) {
      const depDir = resolvePackageDir(dep, dir);
      if (depDir) queue.push({ name: dep, dir: dirname(depDir) });
    }
  }

  // OpenTUI native renderer: one package per target. The host install has the
  // host platform; the other three come from the npm registry.
  if (name === "@mbears/opentui-core") {
    const version = manifest.optionalDependencies[nativePackageForTarget(targets[0])];
    for (const target of targets) {
      const nativeName = nativePackageForTarget(target);
      if (staged.has(nativeName)) continue;
      const hostDir = resolvePackageDir(nativeName, dir)
        ? dirname(resolvePackageDir(nativeName, dir))
        : null;
      const source = hostDir ?? fetchNativePackage(nativeName, version);
      await copyPackage(nativeName, source, destModules);
    }
  }
}

const stageManifest = [...staged].sort();
await writeFile(join(destModules, ".zheadless-tui-staged-packages.txt"), `${stageManifest.join("\n")}\n`);
const hash = createHash("sha256").update(stageManifest.join(",")).digest("hex").slice(0, 12);

mkdir(outDir, { recursive: true });
const outFile = join(outDir, `zheadless-tui-runtime-${tagArg || `dev-${hash}`}.tar.gz`);
execFileSync("tar", ["-czf", outFile, "-C", staging, "node_modules"]);
await rm(staging, { force: true, recursive: true });
await rm(nativeCacheDir, { force: true, recursive: true });

const { size } = await stat(outFile);
console.log(`staged ${staged.size} packages -> ${outFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log(stageManifest.join("\n"));
