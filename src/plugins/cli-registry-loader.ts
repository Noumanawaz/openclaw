/** Loads plugin CLI registrations lazily for the command tree and plugin-owned subcommands. */
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { collectUniqueCommandDescriptors } from "../cli/program/command-descriptor-utils.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { getRuntimeConfig } from "../config/config.js";
import { withConfigPluginMetadataResolver } from "../config/io.plugin-metadata.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveManifestActivationPluginIds } from "./activation-planner.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import { createPluginCliGatewayNodesRuntime } from "./cli-gateway-nodes-runtime.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import { getCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import {
  applyInstalledPluginIndexPolicy,
  resolveInstalledPluginIndexPolicyHash,
} from "./installed-plugin-index-policy.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadOpenClawPluginCliRegistry, loadPluginRegistryHandle } from "./loader.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import {
  fingerprintPluginDiscoveryContext,
  resolvePluginDiscoveryContext,
  resolvePluginControlPlaneFingerprint,
} from "./plugin-control-plane-context.js";
import {
  rebasePluginMetadataSnapshotManifestRegistry,
  resolvePluginMetadataEnvFingerprint,
  resolvePluginMetadataSnapshot,
  restorePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { normalizePluginIdScope } from "./plugin-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import {
  buildPluginRuntimeLoadOptions,
  createPluginRuntimeLoaderLogger,
  resolvePluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type {
  OpenClawPluginCliContext,
  OpenClawPluginCliRootCommandDescriptor,
  PluginLogger,
} from "./types.js";

export type PluginCliLoaderOptions = Pick<PluginLoadOptions, "pluginSdkResolution">;

/** Public CLI loader options passed from command bootstrap surfaces. */
export type PluginCliPublicLoadParams = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loaderOptions?: PluginCliLoaderOptions;
  logger?: PluginLogger;
  primaryCommand?: string;
  session?: PluginCliLoadSession;
};

export type PluginCliCommandGroupEntry = {
  pluginId: string;
  parentPath: readonly string[];
  placeholders: readonly OpenClawPluginCliRootCommandDescriptor[];
  names: readonly string[];
  register: (program: OpenClawPluginCliContext["program"]) => Promise<void>;
};

const log = createSubsystemLogger("plugins/cli-registry-loader");

type PreparedPluginCliLoad = {
  context: PluginRuntimeLoadContext;
  assertCurrent: () => void;
  metadataRegistry?: Promise<PluginRegistry>;
  entries?: Promise<PluginCliCommandGroupEntry[]>;
};

export type PluginCliLoadSession = ReturnType<typeof createPluginCliLoadSession>;

/** One invocation owns discovery and registration; changed inputs replace its prepared facts. */
export function createPluginCliLoadSession() {
  let closed = false;
  let revision = getCurrentPluginMetadataSnapshotState().revision;
  const snapshots = new Map<
    string | undefined,
    { key: string; snapshot: PluginMetadataSnapshot }
  >();
  let metadataEnvKey: string | undefined;
  let current:
    | {
        key: string;
        logger?: PluginLogger;
        sdk?: PluginCliLoaderOptions["pluginSdkResolution"];
        prepared: PreparedPluginCliLoad;
      }
    | undefined;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Plugin CLI preparation is closed; start a new registration operation.");
    }
  };
  const refreshRevision = () => {
    assertOpen();
    const next = getCurrentPluginMetadataSnapshotState().revision;
    if (next !== revision) {
      revision = next;
      snapshots.clear();
      current = undefined;
    }
  };
  const assertRevision = (captured: symbol) => {
    assertOpen();
    if (captured !== getCurrentPluginMetadataSnapshotState().revision) {
      throw new Error(
        "Plugin CLI preparation was invalidated; start a new registration operation.",
      );
    }
  };
  const resolveMetadata: typeof resolvePluginMetadataSnapshot = (params) => {
    refreshRevision();
    const env = params.env ?? process.env;
    const envKey = stableStringify([
      env,
      resolvePluginMetadataEnvFingerprint(env),
      params.stateDir,
    ]);
    if (metadataEnvKey !== envKey) {
      snapshots.clear();
      metadataEnvKey = envKey;
    }
    const key = fingerprintPluginDiscoveryContext(
      resolvePluginDiscoveryContext({
        config: params.config,
        env,
        workspaceDir: params.workspaceDir,
      }),
    );
    const previous = snapshots.get(params.workspaceDir);
    let snapshot = previous?.key === key ? previous.snapshot : undefined;
    if (!snapshot) {
      // Retain the producer's complete source registry, then project exact validation scopes.
      // CLI execution must never promote a union from another workspace into this graph.
      snapshot = resolvePluginMetadataSnapshot({
        ...params,
        pluginIds: undefined,
        pluginIdScope: undefined,
        allowCurrent: false,
      });
      snapshots.set(params.workspaceDir, { key, snapshot });
    }
    const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
    if (snapshot.policyHash !== policyHash) {
      // Policy changes re-evaluate activation over the same inventory, without dropping
      // discovery/provenance or rereading compatible source roots and manifests.
      const index = applyInstalledPluginIndexPolicy(snapshot.index, params.config);
      snapshot = restorePluginMetadataSnapshot({
        ...snapshot,
        index,
        policyHash,
        configFingerprint: resolvePluginControlPlaneFingerprint({
          ...params,
          env,
          index,
          policyHash,
        }),
      });
    }
    const pluginIds = normalizePluginIdScope(
      params.pluginIds ?? params.pluginIdScope?.resolve({ index: snapshot.index }),
    );
    if (pluginIds === undefined) {
      return snapshot;
    }
    const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
      index: snapshot.index,
      manifestRegistry: snapshot.manifestRegistry,
      config: params.config,
      env,
      workspaceDir: params.workspaceDir,
      pluginIds,
      includeDisabled: true,
    });
    return restorePluginMetadataSnapshot({
      ...rebasePluginMetadataSnapshotManifestRegistry(snapshot, manifestRegistry),
      pluginIds,
    });
  };
  return {
    readConfig: async <T>(read: () => Promise<T>): Promise<T> => {
      refreshRevision();
      const captured = revision;
      const result = await withConfigPluginMetadataResolver(resolveMetadata, read);
      assertRevision(captured);
      return result;
    },
    close: () => {
      closed = true;
      current = undefined;
      snapshots.clear();
    },
    resolve: (params: PluginCliPublicLoadParams): PreparedPluginCliLoad => {
      refreshRevision();
      const config =
        params.cfg ?? withConfigPluginMetadataResolver(resolveMetadata, getRuntimeConfig);
      const activationSourceConfig = resolvePluginActivationSourceConfig({ config });
      const env = params.env ?? process.env;
      const inputKey = () =>
        stableStringify([
          config,
          resolvePluginActivationSourceConfig({ config }),
          env,
          resolvePluginControlPlaneWorkspace({ config, env }),
          resolvePluginMetadataEnvFingerprint(env),
          resolveStateDir(env),
          params.primaryCommand,
        ]);
      const key = inputKey();
      const sdk = params.loaderOptions?.pluginSdkResolution;
      // Equal JSON permits inventory reuse, but config/source identities carry private provenance.
      if (
        current?.key === key &&
        current.logger === params.logger &&
        current.sdk === sdk &&
        current.prepared.context.rawConfig === config &&
        current.prepared.context.activationSourceConfig === activationSourceConfig
      ) {
        return current.prepared;
      }
      const context = resolvePluginRuntimeLoadContext({
        config,
        activationSourceConfig,
        // Auto-enable memos trust immutable env identities; each CLI generation owns one.
        env: cloneEnvWithPlatformSemantics(env),
        logger: params.logger ?? createPluginCliLogger(),
        resolveMetadataSnapshot: resolveMetadata,
        allowCurrentMetadata: false,
      });
      const captured = revision;
      const prepared: PreparedPluginCliLoad = {
        context,
        assertCurrent() {
          assertRevision(captured);
          if (
            current?.prepared !== prepared ||
            key !== inputKey() ||
            activationSourceConfig !== resolvePluginActivationSourceConfig({ config }) ||
            current.sdk !== params.loaderOptions?.pluginSdkResolution ||
            current.logger !== params.logger
          ) {
            throw new Error(
              "Plugin CLI preparation inputs changed; start a new registration operation.",
            );
          }
        },
      };
      current = { key, sdk, logger: params.logger, prepared };
      return prepared;
    },
  };
}

function resolvePreparedPluginCliLoad(params: PluginCliPublicLoadParams): PreparedPluginCliLoad {
  return (params.session ?? createPluginCliLoadSession()).resolve(params);
}

/** Creates the default plugin CLI logger shared with runtime loading. */
export function createPluginCliLogger(): PluginLogger {
  return createPluginRuntimeLoaderLogger();
}

function resolvePrimaryCommandManifestPluginIds(
  context: PluginRuntimeLoadContext,
  primaryCommand: string | undefined,
): string[] | undefined {
  const normalizedPrimary = normalizeLowercaseStringOrEmpty(primaryCommand);
  if (!normalizedPrimary) {
    return undefined;
  }
  return resolveManifestActivationPluginIds({
    trigger: {
      kind: "command",
      command: normalizedPrimary,
    },
    config: context.activationSourceConfig,
    workspaceDir: context.workspaceDir,
    env: context.env,
    manifestRecords: context.manifestRegistry?.plugins,
  });
}

function listPluginCliRootOwnerIds(registry: PluginRegistry, primaryCommand: string): string[] {
  const normalizedPrimary = normalizeLowercaseStringOrEmpty(primaryCommand);
  if (!normalizedPrimary) {
    return [];
  }
  return uniqueStrings(
    registry.cliRegistrars
      .filter((entry) => {
        const parentPath = entry.parentPath ?? [];
        const roots =
          parentPath.length > 0
            ? [parentPath[0]]
            : [...entry.commands, ...entry.descriptors.map((descriptor) => descriptor.name)];
        return roots.includes(normalizedPrimary);
      })
      .map((entry) => entry.pluginId),
  );
}

async function resolvePrimaryCommandPluginIds(
  prepared: PreparedPluginCliLoad,
  primaryCommand: string | undefined,
  loaderOptions?: PluginCliLoaderOptions,
): Promise<string[] | undefined> {
  prepared.assertCurrent();
  const { context } = prepared;
  const normalizedPrimary = normalizeLowercaseStringOrEmpty(primaryCommand);
  if (!normalizedPrimary) {
    return undefined;
  }
  const manifestPluginIds = resolvePrimaryCommandManifestPluginIds(context, normalizedPrimary);
  if (manifestPluginIds && manifestPluginIds.length > 0) {
    return manifestPluginIds;
  }
  const registry = await loadPluginCliMetadataRegistryWithContext(
    prepared,
    { primaryCommand: normalizedPrimary },
    loaderOptions,
  );
  prepared.assertCurrent();
  return listPluginCliRootOwnerIds(registry, normalizedPrimary);
}

async function loadPluginCliMetadataRegistryWithContext(
  prepared: PreparedPluginCliLoad,
  params?: { primaryCommand?: string },
  loaderOptions?: PluginCliLoaderOptions,
): Promise<PluginRegistry> {
  const onlyPluginIds = resolvePrimaryCommandManifestPluginIds(
    prepared.context,
    params?.primaryCommand,
  );
  prepared.assertCurrent();
  const registry = await (prepared.metadataRegistry ??= loadOpenClawPluginCliRegistry(
    buildPluginRuntimeLoadOptions(prepared.context, {
      ...loaderOptions,
      ...(onlyPluginIds && onlyPluginIds.length > 0 ? { onlyPluginIds } : {}),
    }),
  ));
  prepared.assertCurrent();
  return registry;
}

async function loadPluginCliCommandRegistryWithContext(params: {
  prepared: PreparedPluginCliLoad;
  primaryCommand?: string;
  loaderOptions?: PluginCliLoaderOptions;
}): Promise<PluginRegistry> {
  const { context } = params.prepared;
  let onlyPluginIds: string[] | undefined;
  try {
    onlyPluginIds = await resolvePrimaryCommandPluginIds(
      params.prepared,
      params.primaryCommand,
      params.loaderOptions,
    );
  } catch {
    onlyPluginIds = resolvePrimaryCommandManifestPluginIds(context, params.primaryCommand);
  }
  params.prepared.assertCurrent();
  if (onlyPluginIds && onlyPluginIds.length === 0) {
    return createEmptyPluginRegistry();
  }
  return loadPluginRegistryHandle(
    buildPluginRuntimeLoadOptions(context, {
      ...params.loaderOptions,
      ...(onlyPluginIds && onlyPluginIds.length > 0 ? { onlyPluginIds } : {}),
      cache: false,
      channelPluginLoadIntent: "full",
      runtimeOptions: { nodes: createPluginCliGatewayNodesRuntime() },
    }),
  );
}

function buildPluginCliCommandGroupEntries(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir: string | undefined;
  logger: PluginLogger;
  assertCurrent: () => void;
}): PluginCliCommandGroupEntry[] {
  return params.registry.cliRegistrars.map((entry) => ({
    pluginId: entry.pluginId,
    parentPath: entry.parentPath ?? [],
    placeholders: entry.descriptors,
    names: entry.commands,
    register: async (program) => {
      params.assertCurrent();
      await entry.register({
        program,
        parentPath: entry.parentPath ?? [],
        config: params.config,
        workspaceDir: params.workspaceDir,
        logger: params.logger,
      });
      params.assertCurrent();
    },
  }));
}

export async function loadPluginCliDescriptors(
  params: PluginCliPublicLoadParams,
): Promise<OpenClawPluginCliRootCommandDescriptor[]> {
  try {
    const prepared = resolvePreparedPluginCliLoad(params);
    const registry = await loadPluginCliMetadataRegistryWithContext(
      prepared,
      { primaryCommand: params.primaryCommand },
      params.loaderOptions,
    );
    return collectUniqueCommandDescriptors(
      registry.cliRegistrars
        .filter((entry) => (entry.parentPath ?? []).length === 0)
        .map((entry) => entry.descriptors),
    );
  } catch (error) {
    // Callers pass a muted per-plugin logger for descriptor scans; a total
    // load failure still removes every plugin command from help/dispatch and
    // must not vanish with it.
    log.warn(`plugin CLI descriptor load failed: ${String(error)}`);
    return [];
  }
}

export async function loadPluginCliRegistrationEntriesWithDefaults(
  params: PluginCliPublicLoadParams,
): Promise<PluginCliCommandGroupEntry[]> {
  const prepared = resolvePreparedPluginCliLoad(params);
  const entries = await (prepared.entries ??= loadPluginCliCommandRegistryWithContext({
    prepared,
    primaryCommand: params.primaryCommand,
    loaderOptions: params.loaderOptions,
  }).then((registry) => {
    prepared.assertCurrent();
    return buildPluginCliCommandGroupEntries({
      ...prepared.context,
      registry,
      assertCurrent: prepared.assertCurrent,
    });
  }));
  prepared.assertCurrent();
  return entries;
}

export async function resolvePluginCliRootOwnerIds(
  params: PluginCliPublicLoadParams,
): Promise<string[] | null> {
  const primaryCommand = normalizeLowercaseStringOrEmpty(params.primaryCommand);
  if (!primaryCommand) {
    return null;
  }
  const prepared = resolvePreparedPluginCliLoad(params);
  const ownerIds = await resolvePrimaryCommandPluginIds(
    prepared,
    primaryCommand,
    params.loaderOptions,
  );
  prepared.assertCurrent();
  return ownerIds ?? null;
}
