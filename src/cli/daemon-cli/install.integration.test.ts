// Daemon install integration tests cover service install paths with filesystem fixtures.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { captureEnv } from "../../test-utils/env.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const { runtimeLogs, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();
const busctl = vi.hoisted(() =>
  vi.fn<typeof import("../../daemon/systemd-exec.js").execBusctlUser>(),
);
vi.mock("../../daemon/systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-exec.js")>()),
  execBusctlUser: busctl,
}));
vi.mock("../../daemon/systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-system.js")>()),
  assertNoSystemSystemdOwnership: async () => {},
}));

const serviceMock = vi.hoisted(() => ({
  label: "Gateway",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  stage: vi.fn(async (_opts?: { environment?: Record<string, string | undefined> }) => {}),
  install: vi.fn(async (_opts?: { environment?: Record<string, string | undefined> }) => {}),
  uninstall: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  isLoaded: vi.fn(async () => false),
  readDefinitionMutationCapability: vi.fn<
    (args?: {
      env?: NodeJS.ProcessEnv;
      environment?: NodeJS.ProcessEnv;
    }) => Promise<import("../../daemon/service-types.js").ServiceDefinitionMutationCapability>
  >(async (_args?: { env?: NodeJS.ProcessEnv; environment?: NodeJS.ProcessEnv }) => ({
    kind: "writable" as const,
  })),
  readCommand: vi.fn<
    typeof import("../../daemon/systemd-service-files.js").readSystemdServiceExecStart
  >(async () => null),
  readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
}));

vi.mock("../../config/paths.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/paths.js")>("../../config/paths.js");
  return { ...actual, isDefaultInstallIdentity: () => true };
});

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => serviceMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

const { runDaemonInstall } = await import("./install.js");
const { clearConfigCache, clearRuntimeConfigSnapshot } = await import("../../config/config.js");
const { readSystemdDefinitionMutationCapability } =
  await import("../../daemon/systemd-definition-mutation.js");
const { readSystemdServiceExecStart } = await import("../../daemon/systemd-service-files.js");
const { assertServiceDefinitionWritable } = await import("../../daemon/service-types.js");

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("runDaemonInstall integration", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome: string;
  let configPath: string;

  beforeAll(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
    tempHome = await makeTempWorkspace("openclaw-daemon-install-int-");
    configPath = path.join(tempHome, "openclaw.json");
    process.env.HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  });

  afterAll(async () => {
    envSnapshot.restore();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    clearRuntimeConfigSnapshot();
    // Keep these defined-but-empty so dotenv won't repopulate from local .env.
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    serviceMock.isLoaded.mockResolvedValue(false);
    serviceMock.readDefinitionMutationCapability.mockResolvedValue({ kind: "writable" });
    serviceMock.readCommand.mockReset();
    serviceMock.readCommand.mockResolvedValue(null);
    await fs.writeFile(configPath, JSON.stringify({}, null, 2));
    clearConfigCache();
  });

  it("fails closed when token SecretRef is required but unresolved", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            auth: {
              mode: "token",
              token: {
                source: "env",
                provider: "default",
                id: "MISSING_GATEWAY_TOKEN",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();

    await expect(runDaemonInstall({ json: true })).rejects.toThrow("__exit__:1");
    expect(serviceMock.install).not.toHaveBeenCalled();
    const joined = runtimeLogs.join("\n");
    expect(joined).toContain("SecretRef is configured but unresolved");
    expect(joined).toContain("MISSING_GATEWAY_TOKEN");
  });

  it.each(["fragment", "drop-in"])(
    "blocks a root-owned manager %s before config or token writes",
    async (kind) => {
      const fixture = await fs.realpath(await fs.mkdtemp(path.join(tempHome, "manager-owner-")));
      const unitPath = path.join(fixture, ".config/systemd/user/openclaw-gateway.service");
      const extra = path.join(fixture, "global-user", "operator.conf");
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.mkdir(path.dirname(extra));
      await fs.writeFile(extra, "[Service]\nEnvironment=TOKEN=operator-secret-canary\n");
      if (kind === "drop-in") {
        await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      }
      const originalLstat = fs.lstat.bind(fs);
      const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await originalLstat(...args);
        if (args[0] === extra) {
          Object.defineProperty(stat, "uid", { value: 0 });
        }
        return stat;
      });
      busctl.mockImplementation(async (_env, args) => ({
        code: 0,
        termination: "exit",
        stderr: "",
        stdout: (args.includes("LoadUnit")
          ? [{ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] }]
          : args.includes("org.freedesktop.systemd1.Unit")
            ? [
                { type: "s", data: kind === "fragment" ? extra : unitPath },
                { type: "as", data: kind === "fragment" ? [] : [extra] },
                { type: "b", data: false },
                { type: "s", data: "loaded" },
              ]
            : [
                {
                  type: "a(sasbttttuii)",
                  data: [
                    ["/usr/bin/node", ["/usr/bin/node", "gateway"], false, 0, 0, 0, 0, 0, 0, 0],
                  ],
                },
                { type: "s", data: "" },
                { type: "as", data: [] },
                { type: "a(sb)", data: [] },
                { type: "as", data: [] },
              ]
        )
          .map((property) => JSON.stringify(property))
          .join("\n"),
      }));
      const env = { ...process.env, HOME: fixture, OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway" };
      serviceMock.readCommand.mockImplementationOnce((_env, options) =>
        readSystemdServiceExecStart(env, options),
      );
      serviceMock.readDefinitionMutationCapability.mockImplementationOnce(() =>
        readSystemdDefinitionMutationCapability(env),
      );
      const before = await fs.readFile(configPath);
      const identity = await fs.lstat(configPath);
      const entries = await fs.readdir(tempHome);
      const managedEntries = await fs.readdir(path.dirname(unitPath));
      try {
        await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");
        expect(await fs.readFile(configPath)).toEqual(before);
        expect((await fs.lstat(configPath)).ino).toBe(identity.ino);
        expect(await fs.readdir(tempHome)).toEqual(entries);
        expect(await fs.readdir(path.dirname(unitPath))).toEqual(managedEntries);
        expect(await fs.readFile(extra, "utf8")).toContain("operator-secret-canary");
        expect(serviceMock.install).not.toHaveBeenCalled();
        expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_SEALED");
        expect(runtimeLogs.join("\n")).not.toContain("secret-canary");
      } finally {
        lstat.mockRestore();
        await fs.rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it("checks the planned generated environment after a drop-in redirects effective state", async () => {
    const fixture = await fs.realpath(await fs.mkdtemp(path.join(tempHome, "planned-owner-")));
    const plannedState = path.join(fixture, "planned");
    const effectiveState = path.join(fixture, "effective");
    const unit = path.join(fixture, ".config/systemd/user/openclaw-gateway.service");
    const dropIn = `${unit}.d/override.conf`;
    const plannedFile = path.join(plannedState, "gateway.systemd.env");
    const effectiveFile = path.join(effectiveState, "gateway.systemd.env");
    const invocation = captureEnv(["HOME", "OPENCLAW_STATE_DIR"]);
    await fs.mkdir(path.dirname(dropIn), { recursive: true });
    await fs.mkdir(plannedState);
    await fs.mkdir(effectiveState);
    await fs.writeFile(plannedFile, "OPERATOR_VALUE=planned\n");
    await fs.writeFile(effectiveFile, "OPERATOR_VALUE=effective\n");
    await fs.writeFile(
      unit,
      `[Service]\nExecStart=/usr/bin/node gateway\nEnvironment=OPENCLAW_STATE_DIR=${plannedState}\nEnvironmentFile=${plannedFile}\n`,
    );
    await fs.writeFile(
      dropIn,
      `[Service]\nEnvironment=OPENCLAW_STATE_DIR=${effectiveState}\nEnvironmentFile=\nEnvironmentFile=${effectiveFile}\n`,
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { auth: { mode: "token", token: "existing-token" } } }),
    );
    process.env.HOME = fixture;
    process.env.OPENCLAW_STATE_DIR = plannedState;
    clearConfigCache();
    const lstat = fs.lstat.bind(fs);
    const owner = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === plannedFile) {
        Object.defineProperty(stat, "uid", { value: 0 });
      }
      return stat;
    });
    busctl.mockImplementation(async (_env, args) => ({
      code: 0,
      termination: "exit",
      stderr: "",
      stdout: (args.includes("LoadUnit")
        ? [{ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] }]
        : args.includes("org.freedesktop.systemd1.Unit")
          ? [
              { type: "s", data: unit },
              { type: "as", data: [dropIn] },
              { type: "b", data: false },
              { type: "s", data: "loaded" },
            ]
          : [
              {
                type: "a(sasbttttuii)",
                data: [["/usr/bin/node", ["/usr/bin/node", "gateway"], false, 0, 0, 0, 0, 0, 0, 0]],
              },
              { type: "s", data: "" },
              { type: "as", data: [`OPENCLAW_STATE_DIR=${effectiveState}`] },
              { type: "a(sb)", data: [[effectiveFile, false]] },
              { type: "as", data: [] },
            ]
      )
        .map((property) => JSON.stringify(property))
        .join("\n"),
    }));
    serviceMock.readCommand.mockImplementation(readSystemdServiceExecStart);
    serviceMock.readDefinitionMutationCapability.mockImplementation((args) =>
      readSystemdDefinitionMutationCapability(args?.env ?? process.env, {
        environment: args?.environment,
      }),
    );
    // Model the actual writer's planned scope without operating a native manager.
    serviceMock.install.mockImplementationOnce(async (args) => {
      assertServiceDefinitionWritable(
        await readSystemdDefinitionMutationCapability(process.env, {
          environment: args?.environment,
        }),
      );
    });
    const before = await fs.readFile(configPath);
    const identity = await fs.lstat(configPath);
    try {
      await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");
      expect(await fs.readFile(configPath)).toEqual(before);
      expect((await fs.lstat(configPath)).ino).toBe(identity.ino);
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_SEALED");
      expect(await fs.readdir(plannedState)).toEqual(["gateway.systemd.env"]);
      expect(await fs.readdir(effectiveState)).toEqual(["gateway.systemd.env"]);
    } finally {
      owner.mockRestore();
      invocation.restore();
      serviceMock.install.mockReset().mockResolvedValue(undefined);
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("refuses service install when config was written by a newer OpenClaw", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          meta: {
            lastTouchedVersion: "9999.1.1",
          },
          gateway: {
            auth: {
              mode: "token",
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();

    await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("Refusing to install or rewrite the gateway service");
  });

  it.each([
    {
      name: "gateway.mode is missing",
      capability: { kind: "sealed" as const, detail: "unit definition is owned by root" },
      config: { gateway: { auth: { mode: "token", token: "existing-token" } } },
      marker: "SERVICE_DEFINITION_SEALED",
    },
    {
      name: "the gateway token is missing",
      capability: { kind: "sealed" as const, detail: "unit definition is owned by root" },
      config: { gateway: { mode: "local", auth: { mode: "token" } } },
      marker: "SERVICE_DEFINITION_SEALED",
    },
    {
      name: "gateway.mode is missing and definition authority is unknown",
      capability: { kind: "unknown" as const, detail: "unit definition cannot be inspected" },
      config: { gateway: { auth: { mode: "token" } } },
      marker: "SERVICE_DEFINITION_UNKNOWN",
    },
  ])(
    "preserves config bytes and directory entries when definition access is refused and $name",
    async ({ capability, config, marker }) => {
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      clearConfigCache();
      serviceMock.readDefinitionMutationCapability.mockResolvedValueOnce(capability as never);
      const originalBytes = await fs.readFile(configPath);
      const originalIdentity = await fs.lstat(configPath);
      const originalEntries = (await fs.readdir(tempHome)).toSorted();

      await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

      const actualIdentity = await fs.lstat(configPath);
      expect(await fs.readFile(configPath)).toEqual(originalBytes);
      expect((await fs.readdir(tempHome)).toSorted()).toEqual(originalEntries);
      expect({
        ino: actualIdentity.ino,
        mode: actualIdentity.mode,
        uid: actualIdentity.uid,
      }).toEqual({
        ino: originalIdentity.ino,
        mode: originalIdentity.mode,
        uid: originalIdentity.uid,
      });
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(serviceMock.readCommand).toHaveBeenCalledOnce();
      expect(runtimeLogs.join("\n")).toContain(marker);
      expect(runtimeLogs.join("\n")).toContain(
        capability.kind === "sealed" ? "deployment owner" : "Inspect service definition access",
      );
    },
  );

  it.each([
    { name: "forced fresh install", loaded: false, force: true },
    { name: "loaded auto-refresh", loaded: true, force: false },
    { name: "forced loaded refresh", loaded: true, force: true },
  ])(
    "preserves config, token, and state when $name cannot inspect its command",
    async ({ loaded, force }) => {
      const secret = "service-command-inspection-secret-canary";
      await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token" } } }));
      clearConfigCache();
      serviceMock.isLoaded.mockResolvedValue(loaded);
      serviceMock.readCommand.mockRejectedValueOnce(new Error(secret));
      const originalBytes = await fs.readFile(configPath);
      const originalIdentity = await fs.lstat(configPath);
      const originalEntries = (await fs.readdir(tempHome)).toSorted();

      await expect(runDaemonInstall({ json: true, force })).rejects.toThrow("__exit__:1");

      expect(await fs.readFile(configPath)).toEqual(originalBytes);
      expect((await fs.lstat(configPath)).ino).toBe(originalIdentity.ino);
      expect((await fs.readdir(tempHome)).toSorted()).toEqual(originalEntries);
      expect(serviceMock.readCommand).toHaveBeenCalledWith(expect.any(Object), {
        requireEffective: true,
      });
      expect(serviceMock.readDefinitionMutationCapability).not.toHaveBeenCalled();
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_UNKNOWN");
      expect(runtimeLogs.join("\n")).not.toContain(secret);
    },
  );

  it("keeps an already-installed service read-only without probing definition authority", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "local", auth: { mode: "token", token: "existing" } } }),
    );
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {},
    } as never);
    const originalBytes = await fs.readFile(configPath);
    const originalEntries = (await fs.readdir(tempHome)).toSorted();

    await runDaemonInstall({ json: true });

    expect(runtimeLogs.join("\n")).toContain('"result": "already-installed"');
    expect(serviceMock.readDefinitionMutationCapability).not.toHaveBeenCalled();
    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath)).toEqual(originalBytes);
    expect((await fs.readdir(tempHome)).toSorted()).toEqual(originalEntries);
  });

  it("repairs missing gateway mode for a loaded sealed service without rewriting its definition", async () => {
    const config = { gateway: { auth: { mode: "token", token: "existing-token" } } };
    await fs.writeFile(configPath, JSON.stringify(config));
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readDefinitionMutationCapability.mockResolvedValue({
      kind: "sealed",
      detail: "unit definition is owned by root",
    } as never);
    serviceMock.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {},
    } as never);

    await runDaemonInstall({ json: true });

    expect((await readJson(configPath)).gateway).toEqual({ ...config.gateway, mode: "local" });
    expect(runtimeLogs.join("\n")).toContain('"result": "already-installed"');
    expect(serviceMock.readDefinitionMutationCapability).not.toHaveBeenCalled();
    expect(serviceMock.install).not.toHaveBeenCalled();
  });

  it("refuses loaded-service auto-refresh before persisting missing gateway defaults", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { auth: { mode: "token", token: "existing-token" } } }),
    );
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: { OPENCLAW_GATEWAY_TOKEN: "outdated-token" },
    } as never);
    serviceMock.readDefinitionMutationCapability.mockResolvedValueOnce({
      kind: "sealed",
      detail: "unit definition is owned by root",
    } as never);
    const originalBytes = await fs.readFile(configPath);
    const originalEntries = (await fs.readdir(tempHome)).toSorted();

    await expect(runDaemonInstall({ json: true })).rejects.toThrow("__exit__:1");

    expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_SEALED");
    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath)).toEqual(originalBytes);
    expect((await fs.readdir(tempHome)).toSorted()).toEqual(originalEntries);
  });

  it("refuses a loaded service's sealed effective state before persisting config or a token", async () => {
    const effectiveStateDir = path.join(tempHome, "sealed-service-state");
    await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token" } } }));
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: { OPENCLAW_STATE_DIR: effectiveStateDir },
    } as never);
    serviceMock.readDefinitionMutationCapability.mockImplementationOnce(
      async (args) =>
        (args?.environment?.OPENCLAW_STATE_DIR === effectiveStateDir
          ? { kind: "sealed", detail: "effective state is owned by root" }
          : { kind: "writable" }) as never,
    );
    const originalBytes = await fs.readFile(configPath);
    const originalEntries = (await fs.readdir(tempHome)).toSorted();

    await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

    expect(serviceMock.readDefinitionMutationCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: tempHome }),
        environment: expect.objectContaining({ OPENCLAW_STATE_DIR: effectiveStateDir }),
      }),
    );
    expect(await fs.readFile(configPath)).toEqual(originalBytes);
    expect((await fs.readdir(tempHome)).toSorted()).toEqual(originalEntries);
    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("SERVICE_DEFINITION_SEALED");
  });

  it.each([
    { name: "system-owned definition", kind: "sealed", force: false },
    {
      name: "custom marker-owned openclaw.service system definition",
      kind: "sealed",
      force: false,
    },
    { name: "dueling user and system definitions", kind: "sealed", force: true },
    { name: "uninspectable definition", kind: "unknown", force: true },
    { name: "rejected definition inspection", kind: "rejected", force: false },
  ])("leaves absent config and state untouched for $name", async ({ kind, force }) => {
    const stateDir = await fs.mkdtemp(path.join(tempHome, "sealed-install-"));
    const missingConfigPath = path.join(stateDir, "openclaw.json");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const secret = "direct-install-capability-secret-canary";
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = missingConfigPath;
    clearConfigCache();
    if (kind === "rejected") {
      serviceMock.readDefinitionMutationCapability.mockRejectedValueOnce(new Error(secret));
    } else {
      serviceMock.readDefinitionMutationCapability.mockResolvedValueOnce({
        kind,
        detail: secret,
      } as never);
    }

    try {
      await expect(runDaemonInstall({ json: true, force })).rejects.toThrow("__exit__:1");

      expect(await fs.readdir(stateDir)).toEqual([]);
      await expect(fs.access(missingConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(serviceMock.readCommand).toHaveBeenCalledOnce();
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect(runtimeLogs.join("\n")).toContain(
        kind === "sealed" ? "SERVICE_DEFINITION_SEALED" : "SERVICE_DEFINITION_UNKNOWN",
      );
      expect(runtimeLogs.join("\n")).not.toContain(secret);
    } finally {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
      clearConfigCache();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("auto-mints token when no source exists without embedding it into service env", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          gateway: {
            auth: {
              mode: "token",
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runDaemonInstall({ json: true });

    expect(serviceMock.install).toHaveBeenCalledTimes(1);
    const updated = await readJson(configPath);
    const gateway = (updated.gateway ?? {}) as { auth?: { token?: string } };
    const persistedToken = gateway.auth?.token;
    expect(persistedToken).toEqual(expect.stringMatching(/^[0-9a-f]{48}$/));

    const installEnv = serviceMock.install.mock.calls[0]?.[0]?.environment;
    expect(installEnv?.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it("logs a generated-token warning without callback indexes or warning arrays", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "local", auth: { mode: "token" } } }),
    );
    clearConfigCache();
    serviceMock.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runDaemonInstall({});

    expect(
      defaultRuntime.log.mock.calls.filter(([message]) =>
        String(message).includes("No gateway token found"),
      ),
    ).toEqual([["No gateway token found. Auto-generated one and saving to config."]]);
  });
});
