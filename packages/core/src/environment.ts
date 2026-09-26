import type { RuntimeInfo } from "@zcode/shared-types";

export { type RuntimeInfo };

// node:sea 只存在于 Node 单文件可执行构建里；Bun 没有该内置模块，按非 SEA 处理。
const isSea = (): boolean => {
  try {
    return process.getBuiltinModule?.("node:sea")?.isSea?.() ?? false;
  } catch {
    return false;
  }
};

export const getRuntimeInfo = (): RuntimeInfo => ({
  arch: process.arch,
  cwd: process.cwd(),
  execPath: process.execPath,
  node: process.version,
  platform: process.platform,
  sea: isSea(),
  versions: process.versions,
});
