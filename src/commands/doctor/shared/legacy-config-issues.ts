// Doctor legacy config issue finder that combines core, channel, and plugin rules.
import { collectChannelLegacyConfigRules } from "../../../channels/plugins/legacy-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { LegacyConfigRule } from "../../../config/legacy.shared.js";
import type {
  ConfigFileSnapshot,
  LegacyConfigIssue,
  OpenClawConfig,
} from "../../../config/types.js";
import {
  collectDoctorConfigRepairPluginIds,
  listPluginDoctorLegacyConfigRules,
} from "../../../plugins/doctor-contract-registry.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";

function collectConfiguredChannelIds(raw: unknown): ReadonlySet<string> {
  return new Set(listDoctorConfiguredChannelIds(raw, { configEntryPolicy: "raw" }));
}

function collectPluginLegacyConfigRules(
  raw: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">,
): LegacyConfigRule[] {
  const channelIds = collectConfiguredChannelIds(raw);
  const pluginIds = collectDoctorConfigRepairPluginIds(raw, touchedPaths, manifestRegistry).filter(
    (pluginId) => !channelIds.has(pluginId),
  );
  if (pluginIds.length === 0) {
    return [];
  }
  return listPluginDoctorLegacyConfigRules({
    config: raw as OpenClawConfig,
    pluginIds,
    ...(manifestRegistry ? { manifestRegistry } : {}),
  });
}

/** Find legacy config issues using core rules plus relevant channel/plugin doctor contracts. */
export function findDoctorLegacyConfigIssues(
  raw: unknown,
  sourceRaw?: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">,
): LegacyConfigIssue[] {
  return findLegacyConfigIssues(
    raw,
    sourceRaw,
    [
      ...collectChannelLegacyConfigRules(raw, touchedPaths, undefined, manifestRegistry),
      ...collectPluginLegacyConfigRules(raw, touchedPaths, manifestRegistry),
    ],
    touchedPaths,
  );
}

export function addDoctorLegacyIssues(
  snapshot: ConfigFileSnapshot,
  pluginMetadataSnapshot?: PluginMetadataSnapshot,
): ConfigFileSnapshot {
  if (!snapshot.exists) {
    return snapshot;
  }
  const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
  const sourceRaw = snapshot.parsed ?? resolvedRaw;
  const legacyIssues = findDoctorLegacyConfigIssues(
    resolvedRaw,
    sourceRaw,
    undefined,
    pluginMetadataSnapshot?.manifestRegistry,
  );
  return legacyIssues.length === 0 ? snapshot : { ...snapshot, legacyIssues };
}
