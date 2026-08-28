import { AsyncLocalStorage } from "node:async_hooks";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  rebasePluginMetadataSnapshotManifestRegistry,
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshotPluginIdScope } from "../plugins/plugin-metadata-snapshot.types.js";
import { normalizePluginPolicyId } from "../plugins/plugin-policy-id.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** The aggregate validates every workspace; only the original snapshots describe execution scopes. */
export type ConfigPluginMetadata = PluginManifestRegistry & {
  workspaceSnapshots: readonly PluginMetadataSnapshot[];
};

const configMetadataResolver = resolveGlobalSingleton(
  Symbol.for("openclaw.configPluginMetadataResolver"),
  () => new AsyncLocalStorage<typeof resolvePluginMetadataSnapshot>(),
);

/** Config reads may borrow an invocation's resolver, never its validation result. */
export function withConfigPluginMetadataResolver<T>(
  resolver: typeof resolvePluginMetadataSnapshot,
  read: () => T,
): T {
  return configMetadataResolver.run(resolver, read);
}

/** Preserve the public read/write aggregate contract; this is not an executable workspace graph. */
export function projectConfigPluginMetadataForReadWrite(
  metadata: ConfigPluginMetadata | undefined,
): PluginMetadataSnapshot | undefined {
  const first = metadata?.workspaceSnapshots[0];
  return first && metadata
    ? rebasePluginMetadataSnapshotManifestRegistry(first, {
        plugins: metadata.plugins,
        diagnostics: metadata.diagnostics,
      })
    : undefined;
}

function mergeRegistries(registries: readonly PluginManifestRegistry[]): PluginManifestRegistry {
  const grouped = new Map<
    string,
    { plugin: PluginManifestRegistry["plugins"][number]; sources: Set<string> }
  >();
  const diagnostics = registries.flatMap((registry) => registry.diagnostics);
  for (const registry of registries) {
    for (const plugin of registry.plugins) {
      const id = normalizePluginPolicyId(plugin.id);
      const group = grouped.get(id) ?? { plugin, sources: new Set<string>() };
      group.plugin = plugin;
      group.sources.add(plugin.source);
      grouped.set(id, group);
    }
  }
  const plugins = [...grouped.entries()].flatMap(([pluginId, group]) => {
    if (group.sources.size === 1) {
      return [group.plugin];
    }
    diagnostics.push({
      level: "error",
      pluginId,
      message: `plugin id ${JSON.stringify(pluginId)} is present in multiple agent workspaces: ${[...group.sources].toSorted().join(", ")}`,
    });
    return [];
  });
  // Registry order carries origin precedence for channel schema ownership.
  // Preserve first discovery order while deduplicating repeated workspace views.
  return { plugins, diagnostics };
}

type ResolveConfigWidePluginMetadataParams = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  allowCurrent?: boolean;
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
};

export function resolveConfigWidePluginManifestRegistry(
  params: ResolveConfigWidePluginMetadataParams,
): ConfigPluginMetadata {
  const env = params.env ?? process.env;
  const dirs = listAgentWorkspaceDirs(params.config, env);
  const workspaceDirs: Array<string | undefined> = dirs.length ? dirs : [undefined];
  const resolveSnapshot = configMetadataResolver.getStore() ?? resolvePluginMetadataSnapshot;
  const workspaceSnapshots = workspaceDirs.map((workspaceDir) =>
    resolveSnapshot({
      config: params.config,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      env,
      allowCurrent: params.allowCurrent,
      allowWorkspaceScopedCurrent: true,
      ...(params.pluginIds !== undefined ? { pluginIds: params.pluginIds } : {}),
      ...(params.pluginIdScope ? { pluginIdScope: params.pluginIdScope } : {}),
    }),
  );
  return {
    ...mergeRegistries(workspaceSnapshots.map((snapshot) => snapshot.manifestRegistry)),
    workspaceSnapshots,
  };
}
