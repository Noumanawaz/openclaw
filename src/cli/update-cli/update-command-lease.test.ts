import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { runExec } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({
  entrypoint: vi.fn(),
  root: vi.fn(),
  doctor: vi.fn(),
  plugins: vi.fn<typeof import("./update-command-plugins.js").updatePluginsAfterCoreUpdate>(),
  restart: vi.fn(async () => true),
  print: vi.fn(),
}));

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.entrypoint,
}));
vi.mock("../../commands/doctor.js", () => ({ doctorCommand: mocks.doctor }));
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./progress.js", () => ({ printResult: mocks.print }));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
  tryWriteCompletionCache: vi.fn(async () => "skipped"),
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restart,
  tryInstallShellCompletion: vi.fn(),
}));

import { updateFinalizeCommand } from "./update-command-finalize.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { finishUpdate } from "./update-command-post-update.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const pluginResult: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};
type Lane = "resume" | "current-process" | "repair";
let state: OpenClawTestState;
let entrypoint: string;

beforeEach(async () => {
  vi.clearAllMocks();
  state = await createOpenClawTestState({
    label: "update-lease",
    env: {
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: undefined,
      OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: undefined,
    },
  });
  await state.writeConfig({ plugins: { enabled: false }, update: { channel: "stable" } });
  await state.writeJson("scenario.json", {});
  await fs.writeFile(state.path("package.json"), JSON.stringify({ version: "1.0.0" }));
  entrypoint = await state.writeText(
    "entry.mjs",
    `
    import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
    const { runUpdateLeaseChild } = await tsImport(${JSON.stringify(pathToFileURL(path.resolve("src/cli/update-cli/update-command-lease.test-support.ts")).href)}, { parentURL: import.meta.url, tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
    await runUpdateLeaseChild();
  `,
  );
  mocks.entrypoint.mockResolvedValue(entrypoint);
  mocks.root.mockResolvedValue(state.root);
  mocks.plugins.mockResolvedValue(pluginResult);
  // The repair path's in-process doctor retains real same-process reentrancy.
  mocks.doctor.mockImplementation(async () => withPluginLifecycleLease({}, async () => undefined));
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

async function invoke(lane: Lane): Promise<void> {
  if (lane === "resume") {
    return resumePostCoreUpdate({
      root: state.root,
      channel: "stable",
      opts: { json: true, yes: true },
      timeoutMs: 15_000,
    });
  }
  if (lane === "repair") {
    return updateFinalizeCommand({
      json: true,
      yes: true,
      restart: false,
      timeout: "15",
      deferCompletionCache: true,
    });
  }
  return finishUpdate({
    result: {
      status: "ok",
      mode: "npm",
      root: state.root,
      before: { version: "2.0.0" },
      after: { version: "1.0.0" },
      steps: [],
      durationMs: 1,
    },
    root: state.root,
    installKindChanged: false,
    configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
    requestedChannel: null,
    storedChannel: "stable",
    channel: "stable",
    downgradeRisk: true,
    shouldRestart: false,
    opts: { json: true, yes: true },
    showProgress: false,
    ownedManagedUpdateEnv: { ...process.env },
    controlPlaneUpdateSentinelMeta: null,
    preUpdatePluginInstallRecords: { stale: { source: "path", sourcePath: state.path("stale") } },
    startedAt: Date.now(),
    updateStepTimeoutMs: 15_000,
  });
}

async function events(): Promise<string[]> {
  return (await fs.readFile(state.statePath("events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const event = JSON.parse(line) as { event: string; pid: number };
      expect(event.pid).not.toBe(process.pid);
      return event.event;
    });
}

function expectSuccess(lane: Lane): void {
  expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  const output =
    lane === "current-process"
      ? mocks.print.mock.lastCall?.[0]
      : vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
  expect(output).toMatchObject({ status: "ok", postUpdate: { plugins: { status: "ok" } } });
  expect(defaultRuntime.log).not.toHaveBeenCalledWith(expect.stringContaining("doctor fixture"));
  expect(defaultRuntime.error).not.toHaveBeenCalledWith(expect.stringContaining("doctor fixture"));
}

describe("update orchestration lifecycle ownership", () => {
  it.each(["resume", "current-process", "repair"] as const)(
    "%s releases ownership for fresh doctor and strict validation",
    async (lane) => {
      await state.writeJson("scenario.json", {
        hostVersion: lane === "repair" ? undefined : "1.0.0",
      });
      await invoke(lane);
      expectSuccess(lane);
      expect(await events()).toEqual([
        ...(lane === "resume" ? ["pre-attempt", "pre-acquired"] : []),
        "post-attempt",
        "post-acquired",
        "validate",
      ]);
      if (lane === "current-process") {
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({ shouldRestart: false }),
        );
      }
    },
  );

  it.each(["resume", "current-process", "repair"] as const)(
    "%s keeps plugin mutation exclusive to its parent",
    async (lane) => {
      mocks.plugins.mockImplementationOnce(async () => {
        const result = await runExec(process.execPath, [entrypoint, "probe"], {
          timeoutMs: 15_000,
        });
        expect(result.stdout).toBe("excluded");
        return pluginResult;
      });
      await invoke(lane);
      expectSuccess(lane);
      expect(mocks.plugins).toHaveBeenCalledOnce();
      const after = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
      expect(after.stdout).toBe("acquired");
    },
  );

  it.each(["current-process", "repair"] as const)(
    "%s reloads config and records after a competing writer commits",
    async (lane) => {
      await writePersistedInstalledPluginIndexInstallRecords({ old: { source: "path" } });
      expect(await loadInstalledPluginIndexInstallRecords()).toHaveProperty("old");
      const writerRecords = { current: { source: "path", sourcePath: state.path("current") } };
      await state.writeJson("scenario.json", {
        writerConfig: {
          plugins: { enabled: false },
          update: { channel: "beta" },
          gateway: { port: 19002 },
        },
        writerRecords,
      });
      const acquired = createDeferred();
      const completed = createDeferred();
      const child = spawn(process.execPath, [entrypoint, "writer"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      if (!child.stderr) {
        throw new Error("writer stderr pipe was not created");
      }
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("message", () => acquired.resolve());
      child.once("error", (error) => {
        acquired.reject(error);
        completed.reject(error);
      });
      child.once("close", (code) => {
        if (code === 0) {
          completed.resolve();
        } else {
          const error = new Error(`writer exited ${code}: ${stderr}`);
          acquired.reject(error);
          completed.reject(error);
        }
      });
      void completed.promise.catch(() => {});
      try {
        await acquired.promise;
        const update = invoke(lane);
        void update.catch(() => {});
        child.send("commit");
        await completed.promise;
        await update;
        expectSuccess(lane);
        expect(mocks.plugins).toHaveBeenCalledWith(
          expect.objectContaining({
            configSnapshot: expect.objectContaining({
              config: expect.objectContaining({
                gateway: expect.objectContaining({ port: 19002 }),
              }),
            }),
            pluginInstallRecords: writerRecords,
          }),
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await completed.promise.catch(() => {});
      }
    },
  );

  it.each([false, true])(
    "resume reads the doctor's committed generation (empty=%s)",
    async (empty) => {
      const old = { old: { source: "path" as const } };
      await writePersistedInstalledPluginIndexInstallRecords(old);
      expect(await loadInstalledPluginIndexInstallRecords()).toEqual(old);
      const recordsPath = await state.writeJson("forwarded.json", old);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH", recordsPath);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS", String(Date.now()));
      const current = empty ? {} : { current: { source: "path" } };
      await state.writeJson("scenario.json", {
        doctorWrites: true,
        writerConfig: { plugins: { enabled: false }, gateway: { port: 19003 } },
        writerRecords: current,
      });
      await invoke("resume");
      expectSuccess("resume");
      expect(mocks.plugins).toHaveBeenCalledWith(
        expect.objectContaining({
          configSnapshot: expect.objectContaining({
            config: expect.objectContaining({ gateway: expect.objectContaining({ port: 19003 }) }),
          }),
          pluginInstallRecords: current,
        }),
      );
      expect(await events()).toEqual([
        "pre-attempt",
        "pre-acquired",
        "writer-committed",
        "post-attempt",
        "post-acquired",
        "validate",
      ]);
    },
  );

  it.each(["resume", "repair"] as const)(
    "%s does not run a final doctor when no plugins changed",
    async (lane) => {
      mocks.plugins.mockResolvedValueOnce({ ...pluginResult, changed: false });
      await invoke(lane);
      expectSuccess(lane);
      if (lane === "resume") {
        expect(await events()).toEqual(["pre-attempt", "pre-acquired"]);
      } else {
        await expect(fs.access(state.statePath("events.jsonl"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it.each(["resume", "current-process", "repair"] as const)(
    "%s retains strict fresh validation after releasing the lease",
    async (lane) => {
      await state.writeJson("scenario.json", { invalidConfig: true });
      await invoke(lane);
      const output =
        lane === "current-process"
          ? mocks.print.mock.lastCall?.[0]
          : vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
      expect(output).toMatchObject({
        status: "error",
        postUpdate: { plugins: { reason: "post-plugin-doctor-invalid-config" } },
      });
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(await events()).toContain("post-acquired");
      expect((await events()).at(-1)).toBe("validate");
      if (lane !== "resume") {
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      }
    },
  );

  it("repair persists a requested channel before its in-process doctor and retains timings", async () => {
    mocks.doctor.mockImplementationOnce(async () =>
      withPluginLifecycleLease({}, async () => {
        expect((await readConfigFileSnapshot()).config.update?.channel).toBe("beta");
        const probe = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
        expect(probe.stdout).toBe("excluded");
      }),
    );
    await updateFinalizeCommand({
      channel: "beta",
      json: true,
      yes: true,
      restart: false,
      deferCompletionCache: true,
    });
    expectSuccess("repair");
    expect(vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0]).toMatchObject({
      channel: "beta",
      restart: false,
      phaseTimings: [
        "targetConfigValidation",
        "configSnapshot",
        "doctor",
        "plugins",
        "targetConfigConvergence",
        "completionCache",
      ].map((phase) =>
        expect.objectContaining({
          phase,
          outcome: phase === "completionCache" ? "deferred" : "completed",
        }),
      ),
    });
  });

  it("propagates a pre-plugin doctor failure before parent mutation", async () => {
    await state.writeJson("scenario.json", { failDoctor: "pre" });
    await expect(invoke("resume")).rejects.toThrow("doctor fixture failure");
    expect(mocks.plugins).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(await events()).toEqual(["pre-attempt", "pre-acquired"]);
  });

  it("keeps a failed final doctor fatal even when strict validation succeeds", async () => {
    await state.writeJson("scenario.json", { failDoctor: "post", hostVersion: "1.0.0" });
    await invoke("current-process");
    expect(mocks.print.mock.lastCall?.[0]).toMatchObject({
      status: "error",
      postUpdate: { plugins: { reason: "post-plugin-doctor-execution-failed" } },
    });
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
    expect(await events()).toEqual(["post-attempt", "post-acquired", "validate"]);
  });
});
