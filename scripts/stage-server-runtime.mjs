// Stage the zh web server runtime: the built entry-http.js plus the external
// dependency tree as a plain node_modules directory, so the server runs away
// from any repo (Node >= 22). Mirrors the upstream distribution staging.
//
//   bun scripts/stage-server-runtime.mjs <out-dir>
//
// <out-dir> receives: entry-http.js, THIRD-PARTY-NOTICES.md, node_modules/
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const outDir = resolve(process.argv[2] ?? "");
if (!outDir || outDir === repoRoot) {
  console.error("usage: bun scripts/stage-server-runtime.mjs <out-dir>");
  process.exit(1);
}

const serverPackageJsonPath = resolve(repoRoot, "packages/server/package.json");
const requireFromServer = createRequire(serverPackageJsonPath);

// The server bundle's external list. Everything here (plus transitive
// dependencies) must ship, or the backend cannot start outside the repo.
const runtimePackageNames = [
  "@hono/node-server",
  "@hono/node-ws",
  "ssh2",
  "node-pty",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "follow-redirects",
  "proxy-from-env",
  "ws",
  "hono",
  "yaml",
  "yazl",
  "yauzl",
  "node-forge",
];

const lydellNodePtyPackages = [
  "@lydell/node-pty-darwin-arm64",
  "@lydell/node-pty-darwin-x64",
  "@lydell/node-pty-linux-arm64",
  "@lydell/node-pty-linux-x64",
];

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const pathExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

function shouldCopyPackagePath(packageDirectory, source) {
  const rel = relative(packageDirectory, source);
  if (!rel) return true;
  const parts = rel.split(sep);
  return !parts.includes("node_modules") && !parts.includes(".git");
}

async function resolvePackageJsonPath(requireFrom, packageName) {
  try {
    return requireFrom.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    // The package exports map hides package.json; walk up from the entry.
    let current = dirname(requireFrom.resolve(packageName));
    for (;;) {
      const candidate = resolve(current, "package.json");
      if (await pathExists(candidate)) {
        try {
          const packageJson = await readJson(candidate);
          if (packageJson.name === packageName) return candidate;
        } catch {
          // malformed nested metadata: keep walking
        }
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

const seen = new Set();
async function copyRuntimePackageTree({ packageName, requireFrom }) {
  if (seen.has(packageName)) return;
  seen.add(packageName);

  const packageJsonPath = await resolvePackageJsonPath(requireFrom, packageName);
  const packageDirectory = dirname(packageJsonPath);
  const destination = resolve(outDir, "node_modules", ...packageName.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await cp(packageDirectory, destination, {
    dereference: true,
    force: true,
    recursive: true,
    filter: (source) => shouldCopyPackagePath(packageDirectory, source),
  });

  const packageJson = await readJson(packageJsonPath);
  const requireFromPackage = createRequire(packageJsonPath);
  const dependencies = Object.assign({}, packageJson.dependencies, packageJson.optionalDependencies);
  for (const dependencyName of Object.keys(dependencies)) {
    try {
      await copyRuntimePackageTree({ packageName: dependencyName, requireFrom: requireFromPackage });
    } catch (error) {
      if (!Object.hasOwn(packageJson.optionalDependencies ?? {}, dependencyName)) throw error;
      console.warn(`optional package ${dependencyName} is unavailable; skipping`);
    }
  }
}

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });
await cp(resolve(repoRoot, "packages/server/dist/entry-http.js"), resolve(outDir, "entry-http.js"));
await cp(
  resolve(repoRoot, "packages/server/dist/THIRD-PARTY-NOTICES.md"),
  resolve(outDir, "THIRD-PARTY-NOTICES.md"),
);

for (const packageName of runtimePackageNames) {
  await copyRuntimePackageTree({ packageName, requireFrom: requireFromServer });
}

// node-pty loads its native addon from prebuilds/<triple>/; the @lydell
// optional dependency packages hold per-platform binaries. Merge them into the
// staged node-pty and make spawn-helper executable on darwin. Packages whose
// os/cpu gating excludes the build machine (bun skips them) are fetched from
// the registry with `bun pm pack`, so the staged tree stays cross-platform.
const nodePtyPrebuildRoot = resolve(outDir, "node_modules", "node-pty", "prebuilds");
const serverPackageJson = await readJson(serverPackageJsonPath);
const ptyPrebuildVersion = serverPackageJson.dependencies?.["@lydell/node-pty-linux-x64"];
for (const packageName of lydellNodePtyPackages) {
  let packageJsonPath;
  try {
    packageJsonPath = await resolvePackageJsonPath(requireFromServer, packageName);
  } catch {
    const staged = await fetchPtyPrebuildsFromRegistry(packageName, ptyPrebuildVersion);
    if (staged) continue;
    console.warn(`${packageName} is unavailable; skipping node-pty prebuild patch`);
    continue;
  }
  const sourcePrebuildRoot = resolve(dirname(packageJsonPath), "prebuilds");
  if (!(await pathExists(sourcePrebuildRoot))) continue;
  await cp(sourcePrebuildRoot, nodePtyPrebuildRoot, { dereference: true, force: true, recursive: true });
}
for (const helper of [
  resolve(nodePtyPrebuildRoot, "darwin-arm64", "spawn-helper"),
  resolve(nodePtyPrebuildRoot, "darwin-x64", "spawn-helper"),
]) {
  if (await pathExists(helper)) await chmod(helper, 0o755);
}

async function fetchPtyPrebuildsFromRegistry(packageName, version) {
  if (!version) return false;
  const workDir = await mkdtemp(resolve(tmpdir(), "zh-pty-"));
  try {
    // bun pm pack ignores remote specs, so resolve the tarball URL through the
    // registry metadata and fetch it directly.
    const metadataResponse = await fetch(`https://registry.npmjs.org/${packageName}`);
    if (!metadataResponse.ok) {
      console.warn(`registry metadata for ${packageName} unavailable (${metadataResponse.status})`);
      return false;
    }
    const metadata = await metadataResponse.json();
    const tarballUrl = metadata.versions?.[version]?.dist?.tarball;
    if (!tarballUrl) {
      console.warn(`registry has no ${packageName}@${version}`);
      return false;
    }
    const tarballResponse = await fetch(tarballUrl);
    if (!tarballResponse.ok) {
      console.warn(`download of ${packageName}@${version} failed (${tarballResponse.status})`);
      return false;
    }
    const tarballPath = resolve(workDir, "package.tgz");
    await writeFile(tarballPath, Buffer.from(await tarballResponse.arrayBuffer()));
    const extract = spawnSync("tar", ["-xzf", tarballPath, "-C", workDir]);
    if (extract.status !== 0) return false;
    const prebuildRoot = resolve(workDir, "package", "prebuilds");
    if (!(await pathExists(prebuildRoot))) return false;
    await mkdir(nodePtyPrebuildRoot, { recursive: true });
    await cp(prebuildRoot, nodePtyPrebuildRoot, { dereference: true, force: true, recursive: true });
    console.log(`fetched ${packageName}@${version} prebuilds from the registry`);
    return true;
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

console.log(`zh server runtime staged -> ${outDir}`);
