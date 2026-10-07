// headless automation 派发器：把一条已落库的 automation run（schedule/manual）提交给
// 当前 host 的 task service（createTask/resumeTask + sendPrompt），并跟踪真实 turn 终态。
// 语义对齐 desktop host 的 dispatchCronRun（upstream packages/desktop/src/host/index.ts）：
// headless server 没有 desktop main / scheduler utilityProcess，派发与结算都在本进程内完成。
import type {
  ModelSelection,
  TraceId,
  ZCodeAutomation,
  ZCodeAutomationRun,
  ZCodeTaskMode,
} from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  IZCodeTaskService,
  ZCodeTaskTerminalOutcome,
} from "#src/session/zcodeTaskService.js";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";

/** 派发请求；runId 契约见 shared parseAutomationRunId（automationId:scheduledAt / automationId:manual:uuid）。 */
export interface AutomationRunDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 派发器依赖的最小 repo/task/model 面；结构化类型让测试可以只 stub 用到的成员。 */
export interface AutomationDispatchRepo {
  get(automationId: string): Promise<ZCodeAutomation | null>;
  getRun(runId: string): Promise<ZCodeAutomationRun | null>;
  getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined>;
  fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection>;
  ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
  }): Promise<void>;
  markRunOutcome(runId: string, outcome: ZCodeAutomationRunOutcome, error?: string): Promise<void>;
  markRunDispatch(params: {
    runId: string;
    dispatchStatus: "dispatched" | "failed_to_dispatch";
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void>;
  markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean>;
  touchManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

type ZCodeAutomationRunOutcome = "running" | "succeeded" | "failed" | "stopped";

export type AutomationTaskService = Pick<
  IZCodeTaskService,
  | "createTask"
  | "resumeTask"
  | "sendPrompt"
  | "setAutomationSessionConfig"
  | "setConfigOption"
  | "setTaskUnread"
  | "onDynamicTaskTerminalOutcome"
>;

export type AutomationModelSelectionService = Pick<IModelSelectionService, "getView">;

/**
 * 在 Automation Select 转为一次 Submission 的边界固定模型身份。
 * 已固定 run 是执行事实：重试不能重新对应账号，也不能因当前读取失败而改变。
 */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: AutomationModelSelectionService;
}): Promise<ModelSelection> {
  if (params.fixedSelection) return params.fixedSelection;
  // Scheduler 的快照可能早于 Host 单向导入；首次执行用持久层校验后的新版意图。
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation model selection is unavailable; reselect model and thinking level");
    }
    return view.effectiveSelection;
  }
  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation cannot resolve a preferred model on the target host");
  }
  return preferredSelection;
}

const MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

/** manual claim 覆盖 queue 等待和 turn 执行；长任务必须续租，否则会被当作僵尸认领回收。 */
export function startManualClaimHeartbeat(params: {
  repo: Pick<AutomationDispatchRepo, "touchManualClaim">;
  automationId: string;
  runId: string;
  workspaceKey: string;
  logWarn: (message: string, error: unknown) => void;
  intervalMs?: number;
}): { dispose(): void } {
  const timer = setInterval(() => {
    void params.repo
      .touchManualClaim(params.automationId, params.workspaceKey)
      .catch((error) =>
        params.logWarn(
          `manual automation claim renewal failed automation=${params.automationId} runId=${params.runId}`,
          error,
        ),
      );
  }, params.intervalMs ?? MANUAL_CLAIM_HEARTBEAT_MS);
  return { dispose: () => clearInterval(timer) };
}

export async function recordCronRunOutcomeBestEffort(params: {
  repo: Pick<AutomationDispatchRepo, "ensureRunClaimed" | "markRunOutcome">;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
  logWarn: (message: string, error: unknown) => void;
}): Promise<void> {
  try {
    await params.repo.ensureRunClaimed({
      runId: params.runId,
      automationId: params.automationId,
      workspaceKey: params.workspaceKey,
      scheduledAt: params.scheduledAt,
      trigger: params.trigger,
    });
    await params.repo.markRunOutcome(params.runId, params.outcome, params.error);
  } catch (error) {
    params.logWarn(
      `failed to record automation run outcome automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

async function releaseManualClaimBestEffort(params: {
  repo: Pick<AutomationDispatchRepo, "releaseManualClaim" | "getRun" | "get">;
  automationId: string;
  runId: string;
  workspaceKey?: string;
  logWarn: (message: string, error: unknown) => void;
}): Promise<void> {
  try {
    // scheduler 重启 / inFlight 丢失后仍可能收到迟到回报；manual single-flight 锁
    // 必须用 run 台账或 automation 兜回 workspaceKey，否则会卡到 stale 回收。
    const releaseWorkspaceKey =
      params.workspaceKey ??
      (await params.repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
      (await params.repo.get(params.automationId).then((automation) => automation?.workspaceKey));
    if (!releaseWorkspaceKey) return;
    await params.repo.releaseManualClaim(params.automationId, releaseWorkspaceKey);
  } catch (error) {
    params.logWarn(
      `failed to release manual automation claim automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

/** 派发失败清理永不覆盖调用方持有的原始 dispatch error。 */
export async function settleManualDispatchFailureBestEffort(params: {
  repo: Pick<
    AutomationDispatchRepo,
    "markRunDispatch" | "releaseManualClaim" | "getRun" | "get"
  >;
  automationId: string;
  runId: string;
  workspaceKey?: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  dispatchError: unknown;
  logWarn: (message: string, error: unknown) => void;
}): Promise<void> {
  const errorMessage =
    params.dispatchError instanceof Error ? params.dispatchError.message : String(params.dispatchError);
  try {
    await params.repo.markRunDispatch({
      runId: params.runId,
      dispatchStatus: "failed_to_dispatch",
      error: errorMessage,
    });
  } catch (error) {
    params.logWarn(
      `failed to record manual automation dispatch failure automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
  await releaseManualClaimBestEffort(params);
}

/** manual claim 只在真实 turn 终态后释放；scheduled run 只回写 outcome。 */
export async function settleCronRunTerminalOutcome(params: {
  repo: Pick<AutomationDispatchRepo, "ensureRunClaimed" | "markRunOutcome" | "releaseManualClaim" | "getRun" | "get">;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
  error?: string;
  logWarn: (message: string, error: unknown) => void;
}): Promise<void> {
  await recordCronRunOutcomeBestEffort(params);
  if (params.trigger !== "manual") return;
  await releaseManualClaimBestEffort(params);
}

/** 已绑定 targetTaskId 的会话在重启后通常不处于 active；先恢复再应用保存的运行参数。 */
async function applyRunConfigToExistingTask(params: {
  taskService: AutomationTaskService;
  taskId: string;
  traceId: string;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.taskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId as TraceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.taskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId as TraceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.taskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId as TraceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AutomationDispatcher {
  /** 提交一条 run 并开始跟踪 turn 终态；resolve 即 prompt 已被 host 接收。 */
  dispatchRun(request: AutomationRunDispatchRequest): Promise<{ taskId: string; sessionId: string }>;
  /** 「立即运行」完整路径：派发 + manual 台账结算；失败时释放 single-flight 并 rethrow。 */
  dispatchManualRun(params: { automation: ZCodeAutomation; run: ZCodeAutomationRun }): Promise<void>;
  dispose(): void;
}

export function createAutomationDispatcher(deps: {
  repo: AutomationDispatchRepo;
  taskService: AutomationTaskService;
  modelSelectionService: AutomationModelSelectionService;
  logger: ServiceLogger;
}): AutomationDispatcher {
  const { repo, taskService, modelSelectionService, logger } = deps;
  const logWarn = (message: string, error: unknown) => logger.warn(undefined, message, error);

  interface RunTracking {
    disposables: Array<{ dispose(): void }>;
  }
  const trackedRuns = new Map<string, RunTracking>();

  function trackRunOutcome(params: {
    taskId: string;
    traceId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
  }): void {
    const key = `${params.taskId}\u0000${params.traceId}`;
    trackedRuns.get(key)?.disposables.forEach((disposable) => disposable.dispose());
    void recordCronRunOutcomeBestEffort({ ...params, repo, outcome: "running", logWarn });
    const disposable = taskService.onDynamicTaskTerminalOutcome(params.taskId)((result: ZCodeTaskTerminalOutcome) => {
      if (result.inputId !== params.traceId) return;
      void settleCronRunTerminalOutcome({
        ...params,
        repo,
        outcome: result.outcome,
        ...(result.error ? { error: result.error } : {}),
        logWarn,
      });
      // 后台完成的定时任务统一置为未读，用户打开 task 时再由导航链路清除。
      void taskService
        .setTaskUnread({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          unread: true,
        })
        .catch((error: unknown) => logWarn(`failed to mark task unread taskId=${params.taskId}`, error));
      trackedRuns.get(key)?.disposables.forEach((disposable) => disposable.dispose());
      trackedRuns.delete(key);
    });
    const claimHeartbeat =
      params.trigger === "manual"
        ? startManualClaimHeartbeat({ ...params, repo, logWarn })
        : null;
    trackedRuns.set(key, {
      disposables: claimHeartbeat ? [disposable, claimHeartbeat] : [disposable],
    });
  }

  async function dispatchRun(
    request: AutomationRunDispatchRequest,
  ): Promise<{ taskId: string; sessionId: string }> {
    // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
    // 不能因账号变化或本次读取失败重新解释历史执行选择。
    const existingRun = await repo.getRun(request.runId);
    const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
      selection: request.modelSelection,
      fixedSelection: existingRun?.modelSelection,
      modelSelectionService,
      readSelection: () =>
        repo.getModelSelectionForDispatch(
          request.automationId,
          resolveWorkspaceKey({
            workspacePath: request.workspacePath,
            workspaceIdentity: request.workspaceIdentity,
          }),
        ),
    });
    const submissionModelSelection = await repo.fixRunModelSelection(
      request.runId,
      resolvedSubmissionModelSelection,
    );
    let trackedKey: string | null = null;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
    });
    const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
    const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
    try {
      const task = request.targetTaskId
        ? { taskId: request.targetTaskId }
        : await taskService.createTask({
            workspacePath: request.workspacePath,
            ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
            modelSelection: submissionModelSelection,
            ...(request.mode?.trim() ? { mode: request.mode.trim() as ZCodeTaskMode } : {}),
            automationId: request.automationId,
          });
      // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId，
      // 终态回写（onDynamicTaskTerminalOutcome.inputId）据此匹配。
      const promptTraceId = request.runId;
      if (request.targetTaskId) {
        await taskService.resumeTask({
          taskId: task.taskId,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          automationId: request.automationId,
        });
        await applyRunConfigToExistingTask({
          taskService,
          taskId: task.taskId,
          traceId: promptTraceId,
          modelSelection: submissionModelSelection,
          ...(request.mode ? { mode: request.mode } : {}),
        });
      }
      trackedKey = `${task.taskId}\u0000${promptTraceId}`;
      trackRunOutcome({
        taskId: task.taskId,
        traceId: promptTraceId,
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
      });
      await taskService.sendPrompt({
        taskId: task.taskId,
        traceId: promptTraceId as TraceId,
        content: request.prompt,
        clientMode: "desktop-continuous",
        automationId: request.automationId,
      });
      return { taskId: task.taskId, sessionId: task.taskId };
    } catch (error) {
      if (trackedKey) {
        trackedRuns.get(trackedKey)?.disposables.forEach((disposable) => disposable.dispose());
        trackedRuns.delete(trackedKey);
      }
      void recordCronRunOutcomeBestEffort({
        repo,
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
        outcome: "failed",
        error: errorToMessage(error),
        logWarn,
      });
      throw error;
    }
  }

  async function dispatchManualRun(params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }): Promise<void> {
    logger.info(
      undefined,
      `manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
    );
    let result: { taskId: string; sessionId: string };
    try {
      result = await dispatchRun({
        automationId: params.automation.automationId,
        runId: params.run.runId,
        prompt: params.automation.prompt,
        ...(params.automation.targetTaskId ? { targetTaskId: params.automation.targetTaskId } : {}),
        modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
        ...(params.automation.mode ? { mode: params.automation.mode } : {}),
        workspacePath: params.automation.workspacePath,
        ...(params.automation.workspaceIdentity
          ? { workspaceIdentity: params.automation.workspaceIdentity }
          : {}),
      });
    } catch (error) {
      logger.warn(
        undefined,
        `manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}: ${errorToMessage(error)}`,
      );
      await settleManualDispatchFailureBestEffort({
        repo,
        automationId: params.automation.automationId,
        runId: params.run.runId,
        workspaceKey: params.automation.workspaceKey,
        scheduledAt: params.run.scheduledAt ?? null,
        trigger: "manual",
        dispatchError: error,
        logWarn,
      });
      throw error;
    }
    try {
      await repo.markManualRunDispatched({
        runId: params.run.runId,
        sessionId: result.sessionId,
        dispatchedAt: Date.now(),
      });
    } catch (error) {
      // prompt 已经 accepted/queued，台账回写失败不能伪装成派发失败并提前释放锁；
      // 真实终态仍由 trackRunOutcome 收口，避免同一 automation 重复排队。
      logWarn(
        `failed to settle manual automation dispatched state automation=${params.automation.automationId} runId=${params.run.runId}`,
        error,
      );
    }
    logger.info(
      undefined,
      `manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
    );
  }

  return {
    dispatchRun,
    dispatchManualRun,
    dispose() {
      trackedRuns.forEach((tracking) =>
        tracking.disposables.forEach((disposable) => disposable.dispose()),
      );
      trackedRuns.clear();
    },
  };
}

/** 从 runId 还原本轮理论触发时间；manual run（automationId:manual:uuid）返回 null。 */
function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
