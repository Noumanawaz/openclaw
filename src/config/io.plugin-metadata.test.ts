import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCliLoadSession } from "../plugins/cli-registry-loader.js";
import * as discovery from "../plugins/discovery.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolveConfigWidePluginManifestRegistry } from "./io.plugin-metadata.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

describe("config-wide prepared metadata", () => {
  it("reuses a workspace graph without widening an explicit plugin scope", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-cli-metadata-scope-"));
    const pluginDir = path.join(root, "plugin");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, "index.cjs"), "module.exports = { register() {} };");
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "prepared",
        configSchema: { type: "object", properties: {} },
      }),
    );
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const config = {
      agents: { defaults: { workspace: root } },
      plugins: { load: { paths: [pluginDir] }, allow: ["prepared"] },
    };
    const session = createPluginCliLoadSession();
    const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
    await session.readConfig(async () => {
      const registry = resolveConfigWidePluginManifestRegistry({ config, env });
      expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["prepared"]);
      expect(discover).toHaveBeenCalledOnce();
      const disabled = { ...config, plugins: { ...config.plugins, enabled: false } };
      const changed = resolveConfigWidePluginManifestRegistry({ config: disabled, env });
      expect(changed.workspaceSnapshots[0]?.discovery).toBe(
        registry.workspaceSnapshots[0]?.discovery,
      );
      expect(changed.workspaceSnapshots[0]?.index.plugins[0]?.enabled).toBe(false);
      expect(changed.workspaceSnapshots[0]?.policyHash).not.toBe(
        registry.workspaceSnapshots[0]?.policyHash,
      );
      expect(discover).toHaveBeenCalledOnce();
      const empty = resolveConfigWidePluginManifestRegistry({ config, env, pluginIds: [] });
      expect(empty.plugins).toEqual([]);
      expect(empty.workspaceSnapshots[0]?.pluginIds).toEqual([]);
      expect(empty.workspaceSnapshots[0]?.index).toBe(registry.workspaceSnapshots[0]?.index);
      expect(resolveConfigWidePluginManifestRegistry({ config, env }).plugins).toEqual(
        registry.plugins,
      );
      expect(discover).toHaveBeenCalledOnce();
    });
    session.close();
  });
  it.each([false, true])(
    "retains cross-workspace duplicate diagnostics (distinct sources=%s)",
    (distinct) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-config-metadata-duplicates-"));
      const writeManifest = (dir: string) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "index.cjs"),
          'throw new Error("manifest discovery cannot execute runtime");',
        );
        fs.writeFileSync(
          path.join(dir, "openclaw.plugin.json"),
          JSON.stringify({ id: "shared", configSchema: { type: "object", properties: {} } }),
        );
      };
      if (distinct) {
        for (const id of ["alpha", "beta"]) {
          writeManifest(path.join(root, id, ".openclaw", "extensions", "shared"));
        }
      } else {
        writeManifest(path.join(root, "shared"));
      }
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            beta: { workspace: path.join(root, "beta") },
            alpha: { workspace: path.join(root, "alpha") },
          },
        },
        plugins: {
          allow: ["shared"],
          ...(distinct ? {} : { load: { paths: [path.join(root, "shared")] } }),
        },
      };
      const metadata = resolveConfigWidePluginManifestRegistry({
        config,
        env: {
          HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        allowCurrent: false,
      });
      expect(metadata.workspaceSnapshots).toHaveLength(2);
      expect(metadata.plugins.map(({ id }) => id)).toEqual(distinct ? [] : ["shared"]);
      const conflicts = metadata.diagnostics.filter(({ message }) =>
        message.includes("multiple agent workspaces"),
      );
      expect(conflicts).toHaveLength(distinct ? 1 : 0);
      if (distinct) {
        expect(conflicts[0]?.message).toContain(path.join(root, "alpha"));
        expect(conflicts[0]?.message).toContain(path.join(root, "beta"));
      }
    },
  );
});
