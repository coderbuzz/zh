import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_RELATIVE_PATH = "config/provider/zcode-builtin.json";

// The bundled provider config ships with the repo. ZCODE_BUILTIN_PROVIDER_CONFIG_SOURCE
// may point at an out-of-tree replacement (e.g. a locally generated config).
export const resolveBuiltinProviderConfigSource = ({ root, env = process.env }) => {
  const override = env.ZCODE_BUILTIN_PROVIDER_CONFIG_SOURCE?.trim();
  return resolve(root, override || CONFIG_RELATIVE_PATH);
};

export const loadBuiltinProviderConfig = async ({ root, env = process.env }) => {
  const sourcePath = resolveBuiltinProviderConfigSource({ root, env });
  const content = await readFile(sourcePath, "utf8");
  return { sourcePath, content };
};

export const stageBuiltinProviderConfig = async ({ root, directory, env = process.env }) => {
  const sourcePath = resolveBuiltinProviderConfigSource({ root, env });
  await mkdir(directory, { recursive: true });
  const targetPath = resolve(directory, "zcode-builtin.json");
  await copyFile(sourcePath, targetPath);
  return { sourcePath, targetPath };
};
