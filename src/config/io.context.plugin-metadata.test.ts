import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createConfigIoContext } from "./io.context.js";
import { projectConfigPluginMetadataForReadWrite } from "./io.plugin-metadata.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(clearPluginMetadataLifecycleCaches);

describe("config IO plugin metadata snapshots", () => {
  it("keeps alternate-workspace read-only channels in the aggregate without widening workspace graphs", () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-config-wide-metadata-"));
    for (const id of ["ops", "research"]) {
      const pluginDir = path.join(root, id, ".openclaw", "extensions", id);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "index.cjs"),
        'throw new Error("read-only discovery must not execute plugins");',
      );
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          channels: [`${id}-chat`],
          configSchema: { type: "object", properties: {} },
          channelConfigs: {
            [`${id}-chat`]: {
              schema: { type: "object", properties: { enabled: { type: "boolean" } } },
            },
          },
        }),
      );
    }
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          ops: { workspace: path.join(root, "ops") },
          research: { workspace: path.join(root, "research") },
        },
      },
      channels: { "research-chat": { enabled: true } },
      plugins: { allow: ["ops", "research"], entries: { research: { enabled: true } } },
    };
    const context = createConfigIoContext({ env, observe: false });
    const loader = context.createValidationPluginMetadataSnapshotLoader({ env });
    loader.load(cfg);
    const metadata = loader.getMetadata()!;
    expect(metadata.plugins.map(({ id }) => id)).toEqual(["ops", "research"]);
    expect(
      metadata.workspaceSnapshots.map((snapshot) => snapshot.plugins.map(({ id }) => id)),
    ).toEqual([["ops"], ["research"]]);
    expect(loader.getMetadata()).toBe(metadata);
    const aggregate = projectConfigPluginMetadataForReadWrite(metadata);
    expect(aggregate?.byPluginId.has("research")).toBe(true);
    expect(
      resolveReadOnlyChannelPluginsForConfig(cfg, { env, metadataSnapshot: aggregate }).plugins.map(
        ({ id }) => id,
      ),
    ).toContain("research-chat");
  });
});
