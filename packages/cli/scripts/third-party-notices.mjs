import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Walk node_modules (scoped packages included) and collect name/version/license
// for every package that ships a manifest. The result is a superset of what the
// bundle actually contains; licenses are aggregated per license expression.
const collectNotices = async (root) => {
  const packages = new Map();
  const visit = async (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "@types") continue;
      if (entry.name.startsWith("@")) {
        await visit(join(directory, entry.name), depth + 1);
        continue;
      }
      const manifestPath = join(directory, entry.name, "package.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch {
        continue;
      }
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
      const license =
        typeof manifest.license === "string"
          ? manifest.license
          : Array.isArray(manifest.licenses)
            ? manifest.licenses.join(" OR ")
            : "UNKNOWN";
      packages.set(manifest.name, { version: manifest.version, license });
    }
  };
  await visit(join(root, "node_modules"), 0);
  return packages;
};

export const readThirdPartyNotices = async (root) => {
  const packages = await collectNotices(resolve(root));
  const lines = [
    "Third-party packages bundled with this build, with their licenses as",
    "declared in each package manifest. Full license texts ship inside the",
    "corresponding packages under node_modules/.",
    "",
  ];
  for (const [name, { version, license }] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`${name}@${version} - ${license}`);
  }
  lines.push("");
  return Buffer.from(lines.join("\n"), "utf8");
};

export const stageThirdPartyNotices = async (outputDirectory, root) => {
  const notices = await readThirdPartyNotices(root);
  const targetPath = join(resolve(outputDirectory), "THIRD_PARTY_NOTICES.md");
  await writeFile(targetPath, notices);
  return { targetPath };
};
