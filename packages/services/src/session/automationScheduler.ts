// headless automation scheduler：单进程内的 cron 轮询/派发循环。
// 职责对齐 upstream desktop 的独立 scheduler 进程（packages/desktop/src/scheduler/index.ts）：
//   - 轮询 tasks-index 的 automations，事务认领到期任务（AutomationRepo.claimDue：BEGIN IMMEDIATE + running 0→1）
//   - misfire 宽限：next_run_at 早于 now 超过宽限期 → 记 skipped run（原因可读）并把
//     一次性任务转 completed；不静默把触发点滚到下一年
//   - 到期任务直接派发（headless 没有跨进程消息，派发在本进程内完成）并结算：
//     dispatched → markDispatched（重算 next_run_at / 生命周期）；失败 → 退避重试
//   - 认领 automation_runs 里的 manual run（孤儿恢复；正常「立即运行」走 direct 派发）
// 本模块只读写 tasks-index，不碰 UI；zh-web（entry-http）是唯一宿主。
import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import { ServiceCollection } from "#src/collection.js";
import { IZCodeTaskService } from "#src/session/zcodeTaskService.js";
import { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  computeAutomationNextRunAt,
  isOneShotAutomation,
} from "#src/session/automationCron.js";
import {
  createAutomationDispatcher,
  type AutomationDispatcher,
} from "#src/session/automationDispatch.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";

/** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低。 */
export const AUTOMATION_POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值，视为「进程停机/宿主休眠期间错过的窗口」→
 * 记 skipped 不补跑（用户可见的历史条目，不再静默滚动到下一年）。
 * 取值需明显大于一次正常轮询延迟（避免把正常到点误判成 misfire），又能覆盖短暂卡顿。
 * 宽限内到点的任务仍会立即补跑（catch-up）。
 */
export const AUTOMATION_MISFIRE_GRACE_MS = 5 * 60_000;

export interface AutomationSchedulerDeps {
  repo: Pick<
    AutomationRepo,
    | "claimDue"
    | "claimManualRuns"
    | "skipAndReschedule"
    | "upsertRunClaimed"
    | "markRunDispatch"
    | "markDispatched"
    | "markDispatchFailed"
    | "get"
    | "releaseClaim"
    | "releaseManualClaim"
    | "close"
  >;
  dispatchRun(request: {
    automationId: string;
    runId: string;
    prompt: string;
    targetTaskId?: string;
    modelSelection?: ZCodeAutomation["modelSelection"];
    mode?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ taskId: string; sessionId: string }>;
  dispatchManualRun(params: { automation: ZCodeAutomation; run: ZCodeAutomationRun }): Promise<void>;
  logger: ServiceLogger;
  pollIntervalMs?: number;
  misfireGraceMs?: number;
}

interface InFlightEntry {  automationId: string;
  trigger: "schedule" | "manual";
  workspaceKey?: string;
}

/**
 * 启动 headless automation 调度循环。返回 wake（立即触发一轮）与 dispose
 * （停表 + 释放在途认领 + 关库；硬杀进程留下的认领由 claimDue 的 stale 回收兜底）。
 */
export function startAutomationScheduler(deps: AutomationSchedulerDeps): {
  wake(): void;
  dispose(): Promise<void>;
} {
  const pollIntervalMs = deps.pollIntervalMs ?? AUTOMATION_POLL_INTERVAL_MS;
  const misfireGraceMs = deps.misfireGraceMs ?? AUTOMATION_MISFIRE_GRACE_MS;
  const { repo, logger } = deps;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let tickRequested = false;
  let disposed = false;
  /** runId → 在途派发上下文；dispose 时逐个释放认领。 */
  const inFlight = new Map<string, InFlightEntry>();

  function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
    return automation.nextRunAt ?? automation.retryAt ?? now;
  }

  async function settleScheduleDispatch(
    automation: ZCodeAutomation,
    runId: string,
    scheduledAt: number,
    requestedAt: number,
  ): Promise<void> {
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    try {
      const result = await deps.dispatchRun({
        automationId: automation.automationId,
        runId,
        prompt: automation.prompt,
        ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
        ...(automation.modelSelection ? { modelSelection: automation.modelSelection } : {}),
        ...(automation.mode ? { mode: automation.mode } : {}),
        workspacePath: automation.workspacePath,
        ...(automation.workspaceIdentity
          ? { workspaceIdentity: automation.workspaceIdentity }
          : {}),
      });
      await repo.markRunDispatch({
        runId,
        dispatchStatus: "dispatched",
        sessionId: result.sessionId,
      });
      // markDispatched 之前重读：有限次计划的 max_runs/lifecycle 以最新行参与判定。
      const fresh = await repo.get(automation.automationId);
      const nextRunAt = fresh ? computeAutomationNextRunAt(fresh, Date.now()) : null;
      await repo.markDispatched(automation.automationId, {
        dispatchedAt: Date.now(),
        nextRunAt,
      });
      logger.info(
        undefined,
        `automation dispatched automation=${automation.automationId} runId=${runId} taskId=${result.taskId} nextRunAt=${nextRunAt ?? "none"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repo.markRunDispatch({
        runId,
        dispatchStatus: "failed_to_dispatch",
        error: message,
      });
      // 派发失败全部按 transient 退避重试；达上限后循环任务跳下一个正常 next_run_at。
      await repo.markDispatchFailed(automation.automationId, {
        failedAt: requestedAt,
        error: message,
        kind: "transient",
        nextRunAt: await repo
          .get(automation.automationId)
          .then((fresh) => (fresh ? computeAutomationNextRunAt(fresh, Date.now()) : null)),
      });
      logger.warn(
        undefined,
        `automation dispatch failed automation=${automation.automationId} runId=${runId}: ${message}`,
      );
    }
  }

  async function handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
    const scheduledAt = resolveScheduledAt(automation, now);
    const runId = `${automation.automationId}:${scheduledAt}`;
    const isRetry = automation.dispatchAttempts > 0;

    // misfire：首轮（非重试）且计划触发时间已远早于 now → 认定错过窗口。
    // 记一条 skipped run（History 可见），不再静默滚动到下一年；
    // 纯一次性任务错过即终态（completed），不得再排程新的执行承诺。
    const missed =
      !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - misfireGraceMs;
    if (missed) {
      const finalize = isOneShotAutomation(automation);
      await repo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey: resolveWorkspaceKey({
          workspacePath: automation.workspacePath,
          workspaceIdentity: automation.workspaceIdentity,
        }),
        scheduledAt,
        reason: "missed_while_host_not_running",
        nextRunAt: finalize ? null : computeAutomationNextRunAt(automation, now),
        finalize,
      });
      logger.info(
        undefined,
        `skipped missed automation window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
      );
      return;
    }

    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey: resolveWorkspaceKey({
        workspacePath: automation.workspacePath,
        workspaceIdentity: automation.workspaceIdentity,
      }),
      scheduledAt,
      trigger: "schedule",
    });
    inFlight.set(runId, { automationId: automation.automationId, trigger: "schedule" });
    // 不 await：一条慢派发不能阻塞同一轮的其它到期任务；dispose 负责收口在途项。
    void settleScheduleDispatch(automation, runId, scheduledAt, now).finally(() => {
      inFlight.delete(runId);
    });
  }

  async function handleClaimedManual(
    automation: ZCodeAutomation,
    run: ZCodeAutomationRun,
  ): Promise<void> {
    inFlight.set(run.runId, {
      automationId: automation.automationId,
      trigger: "manual",
      workspaceKey: automation.workspaceKey,
    });
    try {
      await deps.dispatchManualRun({ automation, run });
    } finally {
      inFlight.delete(run.runId);
    }
  }

  async function tick(): Promise<void> {
    if (disposed || ticking) return;
    ticking = true;
    try {
      do {
        tickRequested = false;
        try {
          const now = Date.now();
          const claimed = await repo.claimDue(now);
          for (const automation of claimed) {
            await handleClaimed(automation, now);
          }
          const manualRuns = await repo.claimManualRuns(now);
          for (const claimedManual of manualRuns) {
            await handleClaimedManual(claimedManual.automation, claimedManual.run);
          }
        } catch (error) {
          logger.error(
            undefined,
            `automation scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // wake 与当前 tick 重叠时不丢弃，本轮完成后立即补跑。
      } while (tickRequested && !disposed);
    } finally {
      ticking = false;
    }
  }

  function requestTick(): void {
    if (disposed) return;
    if (ticking) {
      tickRequested = true;
      return;
    }
    void tick();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
    for (const [runId, context] of inFlight) {
      try {
        if (context.trigger === "manual") {
          if (context.workspaceKey) {
            await repo.releaseManualClaim(context.automationId, context.workspaceKey);
          }
        } else {
          await repo.releaseClaim(context.automationId);
        }
      } catch {
        // 退出路径尽力而为。
      }
      inFlight.delete(runId);
    }
    try {
      repo.close();
    } catch {
      // 忽略。
    }
  }

  logger.info(undefined, "automation scheduler started");
  void tick();
  pollTimer = setInterval(requestTick, pollIntervalMs);
  return { wake: requestTick, dispose };
}

/**
 * headless automation runtime 装配：从本进程 ServiceCollection 解析 task / model-selection
 * 服务，建 dispatcher + scheduler。由 entry-http 调用；desktop 不使用本入口。
 */
export function startHeadlessAutomationRuntime(params: {
  services: ServiceCollection;
  logger?: ServiceLogger;
  pollIntervalMs?: number;
  misfireGraceMs?: number;
}): {
  /** 「立即运行」的直接派发路径（automationService.runNow 落库后由 host 调用）。 */
  dispatchManualRun(params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }): Promise<void>;
  dispose(): Promise<void>;
} {
  const logger = params.logger ?? createServiceLogger("automation-runtime");
  const taskService = params.services.getOptional(IZCodeTaskService);
  const modelSelectionService = params.services.getOptional(IModelSelectionService);
  if (!taskService) {
    throw new Error("Automation runtime requires the ZCode task service.");
  }
  if (!modelSelectionService) {
    throw new Error("Automation runtime requires the model selection service.");
  }
  const repo = new AutomationRepo();
  const dispatcher: AutomationDispatcher = createAutomationDispatcher({
    repo,
    taskService,
    modelSelectionService,
    logger,
  });
  const scheduler = startAutomationScheduler({
    repo,
    dispatchRun: dispatcher.dispatchRun,
    dispatchManualRun: dispatcher.dispatchManualRun,
    logger,
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.misfireGraceMs !== undefined
      ? { misfireGraceMs: params.misfireGraceMs }
      : {}),
  });
  return {
    dispatchManualRun: dispatcher.dispatchManualRun,
    dispose: async () => {
      scheduler.dispose();
      dispatcher.dispose();
    },
  };
}
