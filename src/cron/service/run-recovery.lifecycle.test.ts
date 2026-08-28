import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { advanceCronActiveJobGeneration } from "../active-jobs.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import type { CronJob, CronRunStatus } from "../types.js";
import { start, stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { tryCreateCronTaskRunHandle } from "./task-runs.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-recovery-lifecycle-" });

describe.each(["stopped", "retired", "rescheduled"] as const)(
  "one-shot recovery when %s",
  (mode) => {
    it.each(["ok", "error", "skipped"] as const)(
      "does not replay a catch-up run that finishes as %s after stopping",
      async (status) => {
        const { storePath } = await makeStorePath();
        const nowMs = Date.now();
        const job: CronJob = {
          id: "shutdown-one-shot",
          agentId: "alpha",
          name: "shutdown one-shot",
          enabled: true,
          deleteAfterRun: true,
          createdAtMs: nowMs - 1,
          updatedAtMs: nowMs - 1,
          schedule: { kind: "at", at: new Date(nowMs).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "command", argv: ["true"] },
          delivery: { mode: "none" },
          state: { nextRunAtMs: nowMs },
        };
        await writeCronStoreSnapshot({ storePath, jobs: [job] });
        const started = createDeferred();
        const completion = createDeferred<{ status: CronRunStatus; error?: string }>();
        const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>(async () => {
          started.resolve();
          return completion.promise;
        });
        const onEvent = vi.fn();
        const freshState = () =>
          createCronServiceState({
            storePath,
            cronEnabled: true,
            log: logger,
            nowMs: Date.now,
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
            runCommandJob,
            onEvent,
          });
        const first = freshState();
        // An earlier repair can commit before its interrupted-task notification.
        // That orphan shares this start millisecond, but not this run's receipt.
        tryCreateCronTaskRunHandle({ state: first, job, startedAt: nowMs });
        const startup = start(first);
        try {
          await started.promise;
          if (mode === "rescheduled") {
            // A separate service owns the edit; the finishing service must reload
            // its schedule fence rather than delete the replacement on success.
            const editor = freshState();
            try {
              await update(editor, job.id, {
                schedule: { kind: "at", at: new Date(nowMs + 60_000).toISOString() },
              });
            } finally {
              stop(editor);
            }
          }
          stop(first);
          if (mode === "retired") {
            advanceCronActiveJobGeneration();
          }
          completion.resolve({ status, error: status === "error" ? "command failed" : undefined });
          await startup;
          expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBeUndefined();
          expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toEqual([]);
          for (let restart = 0; restart < 3; restart += 1) {
            const next = freshState();
            try {
              await start(next);
              expect(runCommandJob).toHaveBeenCalledOnce();
              const jobs = (await loadCronStore(storePath)).jobs;
              if (mode === "rescheduled") {
                expect(jobs).toMatchObject([
                  {
                    enabled: true,
                    state: {
                      lastRunStatus: status,
                      nextRunAtMs: nowMs + 60_000,
                      scheduleActivatedAtMs: nowMs,
                    },
                  },
                ]);
              } else if (status === "ok") {
                expect(jobs).toHaveLength(0);
              } else {
                expect(jobs).toMatchObject([{ enabled: false, state: { lastRunStatus: status } }]);
                expect(jobs[0]?.state.startupCatchupAtMs).toBeUndefined();
                expect(jobs[0]?.state.nextRunAtMs).toBeUndefined();
              }
            } finally {
              stop(next);
            }
          }
        } finally {
          stop(first);
          completion.resolve({ status });
          await startup;
        }
      },
    );
  },
);
