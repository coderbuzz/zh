import { createLocalServices, getAppConfigDir, startHeadlessAutomationRuntime } from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // headless host 是 automation 的调度与派发者（desktop 由 main 进程的 scheduler 承担）。
  // manual run 落库后直接派发，不等下一轮 20s 轮询；runtime 在 services 装配完成后启动。
  let automationRuntime: ReturnType<typeof startHeadlessAutomationRuntime> | null = null;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
    onAutomationManualRunRequested: async (params) => {
      if (!automationRuntime) {
        throw new Error("Automation runtime is not started on this host.");
      }
      await automationRuntime.dispatchManualRun(params);
    },
  });
  automationRuntime = startHeadlessAutomationRuntime({ services });

  const server = createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });

  // 优雅收口：停调度循环并释放在途认领（硬杀留下的认领由 claimDue 的 stale 回收兜底）。
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void automationRuntime
      ?.dispose()
      .catch(() => undefined)
      .finally(() => {
        server.close();
        process.kill(process.pid, signal);
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
