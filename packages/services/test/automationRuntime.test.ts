// headless automation runtime 测试：misfire 记录/终态、到期补跑、派发失败退避、
// manual run 孤儿恢复与 direct 派发路径（runAutomationNow 的后端）。
// repo 全部注入临时 tasks-index.sqlite，不触碰真实库。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ModelSelection,
  ZCodeAutomation,
  ZCodeAutomationRun,
} from "@zcode/shared";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";
import {
  createAutomationDispatcher,
  type AutomationTaskService,
} from "../src/session/automationDispatch.js";
import {
  AUTOMATION_MISFIRE_GRACE_MS,
  startAutomationScheduler,
} from "../src/session/automationScheduler.js";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";

const silentLogger: ServiceLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function createTempRepo(label: string): { repo: AutomationRepo; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `zh-automation-${label}-`));
  const dbPath = join(dir, "tasks-index.sqlite");
  return { repo: new AutomationRepo(dbPath), dbPath };
}

async function waitFor(
  label: string,
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const minuteSchedule = { cronExpr: "* * * * *", recurring: true };

async function seedRecurringAutomation(repo: AutomationRepo): Promise<ZCodeAutomation> {
  const service = new AutomationService(repo);
  const automation = await service.create({
    title: "every minute",
    ...minuteSchedule,
    prompt: "tick",
    workspacePath: "/tmp/ws",
    recurring: true,
  });
  return automation;
}

/** 把调度指针拨回过去，模拟「宿主停机期间错过触发」。 */
async function rewindNextRunAt(repo: AutomationRepo, automationId: string, nextRunAt: number) {
  await repo.update(automationId, {}, { nextRunAt });
}

interface DispatchCall {
  automationId: string;
  runId: string;
  prompt: string;
}

function startTestScheduler(
  repo: AutomationRepo,
  options: {
    dispatchRun?: (call: DispatchCall) => Promise<{ taskId: string; sessionId: string }>;
    dispatchManualRun?: (params: { automation: ZCodeAutomation; run: ZCodeAutomationRun }) => Promise<void>;
    pollIntervalMs?: number;
    misfireGraceMs?: number;
  } = {},
) {
  const dispatchCalls: DispatchCall[] = [];
  const manualCalls: Array<{ automation: ZCodeAutomation; run: ZCodeAutomationRun }> = [];
  const scheduler = startAutomationScheduler({
    repo,
    dispatchRun: async (request) => {
      dispatchCalls.push({
        automationId: request.automationId,
        runId: request.runId,
        prompt: request.prompt,
      });
      return options.dispatchRun
        ? await options.dispatchRun(request)
        : { taskId: `task-${request.runId}`, sessionId: `task-${request.runId}` };
    },
    dispatchManualRun: async (params) => {
      manualCalls.push(params);
      if (options.dispatchManualRun) {
        await options.dispatchManualRun(params);
        return;
      }
      // 默认按 direct 派发者的合同结算 manual run（真实实现见 automationDispatch）。
      await repo.markManualRunDispatched({
        runId: params.run.runId,
        sessionId: `task-${params.run.runId}`,
        dispatchedAt: Date.now(),
      });
    },
    logger: silentLogger,
    pollIntervalMs: options.pollIntervalMs ?? 25,
    ...(options.misfireGraceMs !== undefined
      ? { misfireGraceMs: options.misfireGraceMs }
      : {}),
  });
  return { scheduler, dispatchCalls, manualCalls };
}

test("due automation within misfire grace is dispatched (catch-up) and rescheduled", async () => {
  const { repo } = createTempRepo("catchup");
  try {
    const automation = await seedRecurringAutomation(repo);
    // 错过 1 分钟（远小于 misfire 宽限）→ 应立即补跑，而不是记 skipped。
    await rewindNextRunAt(repo, automation.automationId, Date.now() - 60_000);
    const { scheduler, dispatchCalls } = startTestScheduler(repo);
    try {
      await waitFor("dispatched run", () => dispatchCalls.length > 0);
      await waitFor(
        "markDispatched settle",
        async () => (await repo.get(automation.automationId))?.runCount === 1,
      );
      const fresh = await repo.get(automation.automationId);
      assert.equal(fresh?.dispatchStatus, "dispatched");
      assert.ok((fresh?.nextRunAt ?? 0) > Date.now(), "nextRunAt advanced to a future match");
      const run = await repo.getRun(dispatchCalls[0]!.runId);
      assert.equal(run?.dispatchStatus, "dispatched");
    } finally {
      await scheduler.dispose();
    }
  } finally {
    repo.close();
  }
});

test("one-shot missed window is recorded as skipped run and finalized", async () => {
  const { repo } = createTempRepo("oneshot-missed");
  try {
    const service = new AutomationService(repo);
    // 纯一次性：recurring=false（默认 maxRuns=1）。next_run_at 拨回 1 小时前 → misfire。
    const automation = await service.create({
      title: "one shot",
      cronExpr: "11 1 8 10 *",
      prompt: "once",
      workspacePath: "/tmp/ws",
      recurring: false,
    });
    await rewindNextRunAt(repo, automation.automationId, Date.now() - 3_600_000);
    const { scheduler, dispatchCalls } = startTestScheduler(repo);
    try {
      await waitFor(
        "finalized automation",
        async () => (await repo.get(automation.automationId))?.lifecycleStatus === "completed",
      );
      assert.equal(dispatchCalls.length, 0, "missed one-shot must not dispatch");
      const fresh = await repo.get(automation.automationId);
      assert.equal(fresh?.enabled, false);
      assert.equal(fresh?.nextRunAt, undefined);
      const runs = await repo.listRuns(automation.automationId);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.dispatchStatus, "skipped");
      assert.equal(runs[0]!.trigger, "schedule");
      assert.match(runs[0]!.error ?? "", /missed_while_host_not_running/);
      // skipped 不计 runCount：Card 展示与 UI History 状态一致。
      assert.equal(fresh?.runCount, 0);
    } finally {
      await scheduler.dispose();
    }
  } finally {
    repo.close();
  }
});

test("recurring missed window is recorded as skipped and rescheduled to the next match", async () => {
  const { repo } = createTempRepo("recurring-missed");
  try {
    const automation = await seedRecurringAutomation(repo);
    await rewindNextRunAt(repo, automation.automationId, Date.now() - 3_600_000);
    const { scheduler, dispatchCalls } = startTestScheduler(repo);
    try {
      await waitFor("skipped run", async () => {
        const runs = await repo.listRuns(automation.automationId);
        return runs.length > 0 && runs[0]!.dispatchStatus === "skipped";
      });
      assert.equal(dispatchCalls.length, 0);
      const fresh = await repo.get(automation.automationId);
      assert.equal(fresh?.lifecycleStatus, "active");
      assert.ok(
        (fresh?.nextRunAt ?? 0) > Date.now(),
        "recurring automation is rescheduled, not rolled silently",
      );
      const runs = await repo.listRuns(automation.automationId);
      assert.match(runs[0]!.error ?? "", /missed_while_host_not_running/);
    } finally {
      await scheduler.dispose();
    }
  } finally {
    repo.close();
  }
});

test("dispatch failure records failed run and arms retry backoff", async () => {
  const { repo } = createTempRepo("dispatch-fail");
  try {
    const automation = await seedRecurringAutomation(repo);
    await rewindNextRunAt(repo, automation.automationId, Date.now() - 1_000);
    const { scheduler, dispatchCalls } = startTestScheduler(repo, {
      dispatchRun: async () => {
        throw new Error("runtime unavailable");
      },
    });
    try {
      await waitFor("failed run", async () => {
        const runs = await repo.listRuns(automation.automationId);
        return runs.some((run) => run.dispatchStatus === "failed_to_dispatch");
      });
      assert.ok(dispatchCalls.length >= 1);
      const fresh = await repo.get(automation.automationId);
      assert.equal(fresh?.dispatchAttempts, 1);
      assert.equal(fresh?.lifecycleStatus, "active");
      assert.ok(
        (fresh?.retryAt ?? 0) > Date.now(),
        "retry scheduled with backoff, not immediately",
      );
      assert.match(fresh?.lastError ?? "", /runtime unavailable/);
      const attemptsBefore = dispatchCalls.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(
        dispatchCalls.length,
        attemptsBefore,
        "backed-off automation is not retried before retry_at",
      );
    } finally {
      await scheduler.dispose();
      // 释放在途认领，便于 close。
      await repo.releaseClaim(automation.automationId).catch(() => undefined);
    }
  } finally {
    repo.close();
  }
});

test("orphaned manual run is recovered and settled by the scheduler tick", async () => {
  const { repo, dbPath } = createTempRepo("manual-recovery");
  try {
    const automation = await seedRecurringAutomation(repo);
    // 模拟「立即运行」落库后 direct 派发者崩溃：run 停在 claimed，automation 占着锁。
    const claimed = await repo.runNow(automation.automationId, { now: Date.now() });
    assert.ok(claimed, "runNow claims the automation");
    // 把认领与 run 台账拨回 stale（CLAIM_STALE_MS=10min），scheduler 应回收派发。
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE automations SET claimed_at = ? WHERE automation_id = ?`,
    ).run(Date.now() - AUTOMATION_MISFIRE_GRACE_MS * 3, automation.automationId);
    db.prepare(
      `UPDATE automation_runs SET updated_at = ? WHERE run_id = ?`,
    ).run(Date.now() - AUTOMATION_MISFIRE_GRACE_MS * 3, claimed!.run.runId);
    db.close();

    const { scheduler, manualCalls } = startTestScheduler(repo);
    try {
      await waitFor("manual recovery dispatch", () => manualCalls.length > 0);
      assert.equal(manualCalls[0]!.run.runId, claimed!.run.runId);
      await waitFor(
        "manual run settled",
        async () =>
          (await repo.getRun(claimed!.run.runId))?.dispatchStatus === "dispatched",
      );
      const fresh = await repo.get(automation.automationId);
      assert.equal(fresh?.runCount, 1, "manual run increments the card counter");
      // manual 派发不推进 cron 计划：next_run_at 保持不变。
      assert.equal(fresh?.nextRunAt, automation.nextRunAt);
    } finally {
      await scheduler.dispose();
    }
  } finally {
    repo.close();
  }
});

// ---- dispatcher（direct 派发路径，即 runAutomationNow 的后端）----

type TerminalListener = (outcome: {
  taskId: string;
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  error?: string;
}) => void;

function createStubTaskService(options: {
  createTaskError?: Error;
  listeners: Map<string, Set<TerminalListener>>;
}) {
  const calls = {
    created: [] as Array<{ params: Record<string, unknown> }>,
    prompts: [] as Array<{ taskId: string; traceId: string; content: string }>,
    resumed: [] as string[],
    unread: [] as string[],
  };
  const taskService = {
    async createTask(params: Record<string, unknown>) {
      if (options.createTaskError) throw options.createTaskError;
      calls.created.push({ params });
      return { taskId: `task-${calls.created.length}` };
    },
    async resumeTask(params: { taskId: string }) {
      calls.resumed.push(params.taskId);
      return {} as never;
    },
    async sendPrompt(params: { taskId: string; traceId: string; content: string }) {
      calls.prompts.push({
        taskId: params.taskId,
        traceId: params.traceId,
        content: params.content,
      });
    },
    async setAutomationSessionConfig() {
      return [] as never;
    },
    async setConfigOption() {
      return [] as never;
    },
    async setTaskUnread(params: { taskId: string }) {
      calls.unread.push(params.taskId);
    },
    onDynamicTaskTerminalOutcome(taskId: string) {
      const set = options.listeners.get(taskId) ?? new Set<TerminalListener>();
      options.listeners.set(taskId, set);
      return ((listener: TerminalListener) => {
        set.add(listener);
        return { dispose: () => set.delete(listener) };
      }) as never;
    },
  };
  return { taskService: taskService as unknown as AutomationTaskService, calls };
}

const modelSelectionServiceStub = {
  async getView(input?: { selection?: ModelSelection | null }) {
    const selection = input?.selection
      ? input.selection
      : ({
          providerId: "glm",
          modelId: "glm-4.6",
          options: { reasoningLevel: "high" },
        } as unknown as ModelSelection);
    return {
      selectionIssue: undefined,
      effectiveSelection: selection,
      preferredSelection: selection,
    } as never;
  },
};

function emitTerminal(
  listeners: Map<string, Set<TerminalListener>>,
  taskId: string,
  outcome: { inputId?: string; outcome: "succeeded" | "failed" | "stopped"; error?: string },
) {
  for (const listener of listeners.get(taskId) ?? []) {
    listener({ taskId, ...outcome });
  }
}

async function seedManualRun(repo: AutomationRepo): Promise<{
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}> {
  const service = new AutomationService(repo);
  const automation = await service.create({
    title: "manual target",
    cronExpr: "0 12 * * *",
    prompt: "manual prompt",
    workspacePath: "/tmp/ws",
    recurring: true,
  });
  const claimed = await repo.runNow(automation.automationId, { now: Date.now() });
  assert.ok(claimed);
  return { automation, run: claimed.run };
}

test("dispatcher manual run dispatches, settles台账, and closes out on terminal outcome", async () => {
  const { repo } = createTempRepo("dispatcher-manual");
  try {
    const listeners = new Map<string, Set<TerminalListener>>();
    const { taskService, calls } = createStubTaskService({ listeners });
    const dispatcher = createAutomationDispatcher({
      repo,
      taskService,
      modelSelectionService: modelSelectionServiceStub,
      logger: silentLogger,
    });
    const { automation, run } = await seedManualRun(repo);
    await dispatcher.dispatchManualRun({ automation, run });

    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0]!.params.automationId, automation.automationId);
    assert.ok(calls.prompts[0]!.traceId.startsWith(`${automation.automationId}:manual:`));
    assert.equal(calls.prompts[0]!.content, "manual prompt");

    const settledRun = await repo.getRun(run.runId);
    assert.equal(settledRun?.dispatchStatus, "dispatched");
    assert.equal(settledRun?.sessionId, "task-1");
    const fresh = await repo.get(automation.automationId);
    assert.equal(fresh?.runCount, 1);

    // turn 真实终态：run outcome 收口 + manual single-flight 释放（runNow 可再次认领）。
    emitTerminal(listeners, "task-1", { inputId: run.runId, outcome: "succeeded" });
    await waitFor(
      "terminal outcome",
      async () => (await repo.getRun(run.runId))?.outcome === "succeeded",
    );
    assert.ok(calls.unread.includes("task-1"), "finished background run is marked unread");
    const again = await repo.runNow(automation.automationId, { now: Date.now() });
    assert.ok(again, "manual claim released after terminal outcome");
    dispatcher.dispose();
  } finally {
    repo.close();
  }
});

test("dispatcher failure marks run failed_to_dispatch and releases the manual claim", async () => {
  const { repo } = createTempRepo("dispatcher-fail");
  try {
    const listeners = new Map<string, Set<TerminalListener>>();
    const { taskService } = createStubTaskService({
      listeners,
      createTaskError: new Error("model unavailable"),
    });
    const dispatcher = createAutomationDispatcher({
      repo,
      taskService,
      modelSelectionService: modelSelectionServiceStub,
      logger: silentLogger,
    });
    const { automation, run } = await seedManualRun(repo);
    await assert.rejects(
      () => dispatcher.dispatchManualRun({ automation, run }),
      /model unavailable/,
    );
    const settledRun = await repo.getRun(run.runId);
    assert.equal(settledRun?.dispatchStatus, "failed_to_dispatch");
    assert.match(settledRun?.error ?? "", /model unavailable/);
    const fresh = await repo.get(automation.automationId);
    assert.equal(fresh?.runCount, 0, "failed dispatch must not increment runCount");
    // 锁已释放：立即再次 runNow 能认领（否则 UI 重试会被卡 10 分钟）。
    const again = await repo.runNow(automation.automationId, { now: Date.now() });
    assert.ok(again, "manual claim released after dispatch failure");
    dispatcher.dispose();
  } finally {
    repo.close();
  }
});

test("dispatcher reuses the fixed run model selection across dispatches", async () => {
  const { repo } = createTempRepo("dispatcher-model");
  try {
    const listeners = new Map<string, Set<TerminalListener>>();
    const { taskService, calls } = createStubTaskService({ listeners });
    const dispatcher = createAutomationDispatcher({
      repo,
      taskService,
      modelSelectionService: modelSelectionServiceStub,
      logger: silentLogger,
    });
    const { automation, run } = await seedManualRun(repo);
    // 首次派发把 workspace 首选固定进 run 台账。
    await dispatcher.dispatchManualRun({ automation, run });
    const fixed = (await repo.getRun(run.runId))?.modelSelection;
    assert.ok(fixed, "run selection fixed on first dispatch");
    assert.deepEqual(calls.created[0]!.params.modelSelection, fixed);

    // 同一 run 重派（重试路径）必须复用固定值，不能因当前首选变化重新解释。
    const changedPreferred = {
      providerId: "other",
      modelId: "other-1",
      options: { reasoningLevel: "low" },
    };
    const dispatcher2 = createAutomationDispatcher({
      repo,
      taskService,
      modelSelectionService: {
        getView: async () =>
          ({
            effectiveSelection: changedPreferred,
            preferredSelection: changedPreferred,
          }) as never,
      },
      logger: silentLogger,
    });
    await repo.markRunDispatch({
      runId: run.runId,
      dispatchStatus: "failed_to_dispatch",
      error: "retry me",
    });
    await dispatcher2.dispatchManualRun({ automation: automation, run: run });
    assert.deepEqual(calls.created.at(-1)!.params.modelSelection, fixed);
    dispatcher2.dispose();
    dispatcher.dispose();
  } finally {
    repo.close();
  }
});
