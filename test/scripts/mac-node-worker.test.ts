// Exercise publication and provisioning boundaries without signing, service control, or operator state.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe("Mac app worker publication", () => {
  it.each(["sign", "worker", "seal", "stage", "success"])(
    "publishes only a verified replacement (%s)",
    (failure) => {
      const root = temps.make("openclaw-worker-publication-");
      const target = path.join(root, "OpenClaw.app");
      const staged = path.join(root, "candidate.app");
      mkdirSync(target);
      mkdirSync(staged);
      writeFileSync(path.join(target, "worker"), "old signed worker");
      writeFileSync(path.join(staged, "worker"), "new signed worker");
      const packageScript = readFileSync("scripts/package-mac-app.sh", "utf8");
      const publication = packageScript.slice(
        packageScript.indexOf('if [[ -n "${SIGN_IDENTITY:-}" ]]'),
      );
      const worker = path.join(staged, "Contents/Resources/node-worker/arm64/bin/node");
      mkdirSync(path.dirname(worker), { recursive: true });
      writeFileSync(worker, `#!/bin/bash\nexit ${failure === "worker" ? 6 : 0}\n`);
      chmodSync(worker, 0o755);
      const scripts = path.join(root, "scripts");
      mkdirSync(scripts);
      writeFileSync(
        path.join(scripts, "codesign-mac-app.sh"),
        `#!/bin/bash\nexit ${failure === "sign" ? 9 : 0}\n`,
      );
      chmodSync(path.join(scripts, "codesign-mac-app.sh"), 0o755);
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `
      set -euo pipefail
      source scripts/lib/mac-app-bundle.sh
      ROOT_DIR=${quote(root)}
      APP_ROOT=${quote(staged)}
      APP_STAGE_DIR=${quote(root)}
      BUILD_ARCHS=(arm64)
      APP_DESTINATION=${quote(target)}
      codesign_calls=0
      codesign() {
        codesign_calls=$((codesign_calls + 1))
        if [[ ${quote(failure)} == seal && "$codesign_calls" -eq 2 ]]; then return 1; fi
        return 0
      }
      stop_packaged_app_if_running() { :; }
      mv() {
        if [[ "$1" == "$APP_ROOT" && ${quote(failure)} == stage ]]; then return 7; fi
        command mv "$@"
      }
      ${publication}
    `,
        ],
        { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin" } },
      );
      expect(result.status, result.stderr).toBe(
        failure === "success" ? 0 : failure === "worker" ? 6 : failure === "sign" ? 9 : 1,
      );
      expect(readFileSync(path.join(target, "worker"), "utf8")).toBe(
        failure === "success" ? "new signed worker" : "old signed worker",
      );
    },
  );

  it("provisions packages without invoking the service owner or changing operator state", () => {
    const root = temps.make("openclaw-worker-provision-");
    const home = path.join(root, "home");
    const prefix = path.join(root, "private");
    const sentinel = path.join(root, "operator", ".openclaw", "state", "sentinel");
    mkdirSync(path.dirname(sentinel), { recursive: true });
    mkdirSync(home);
    writeFileSync(sentinel, "operator-owned");
    const nodeDir = path.join(prefix, "tools", "node-v24.19.0");
    mkdirSync(path.join(nodeDir, "bin"), { recursive: true });
    // Only npm/network is replaced. The real install_openclaw implementation
    // must remain a provision-only seam even when a loaded Gateway is reported.
    symlinkSync(process.execPath, path.join(nodeDir, "bin", "node"));
    const npm = path.join(nodeDir, "bin", "npm");
    writeFileSync(
      npm,
      `#!/bin/bash
case "$1" in
  --version) echo 11.15.0 ;;
  config) echo null ;;
  install)
    mkdir -p "$HOME/../private/tools/node-v24.19.0/lib/node_modules/openclaw/dist"
    touch "$HOME/../private/tools/node-v24.19.0/lib/node_modules/openclaw/dist/entry.js"
    ;;
  *) exit 4 ;;
esac
`,
    );
    chmodSync(npm, 0o755);
    const calls = path.join(root, "service-calls");
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `
      set -euo pipefail
      source scripts/install-cli.sh
      PREFIX=${quote(prefix)}
      OPENCLAW_VERSION=/fixture/openclaw.tgz
      is_gateway_daemon_loaded() { echo loaded >> ${quote(calls)}; return 0; }
      refresh_gateway_service_if_loaded() { echo refresh >> ${quote(calls)}; }
      install_openclaw
      test -f "$(node_dir)/lib/node_modules/openclaw/dist/entry.js"
    `,
      ],
      {
        encoding: "utf8",
        env: {
          HOME: home,
          PATH: `${path.join(nodeDir, "bin")}:/usr/bin:/bin`,
          OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("operator-owned");
  });
});
