import type { RuntimeInfo } from "@zcode/shared-types";

export { type RuntimeInfo };

type SeaModule = { isSea(): boolean };

/**
 * SEA 探针不能静态 `import "node:sea"`：Bun 没有 node:sea 内建模块，
 * 静态导入会直接抛 ERR_UNKNOWN_BUILTIN_MODULE 让整个 CLI 起不来。
 * 走 process.getBuiltinModule 动态探针（Bun 下返回 undefined ⇒ 判 false），
 * 与 bootstrap 的 isSeaRuntime 镜像同一套兜底语义。
 */
const isSeaRuntime = (): boolean => {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => SeaModule)
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
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
  sea: isSeaRuntime(),
  versions: process.versions,
});
