#!/usr/bin/env node
import assert from "node:assert/strict";
// Package proof: relocation, native load dependencies, provenance, and actual
// JSONL worker readiness. Never admits or opens the operator's live state.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { runManagedCommand, terminateManagedChild } from "./lib/managed-child-process.mts";

const [runtimeArg, expectedInfoPath] = process.argv.slice(2);
if (!runtimeArg || !expectedInfoPath) {
  throw new Error("Usage: verify-mac-node-worker.mjs <runtime> <expected-build-info.json>");
}
const runtime = fs.realpathSync(runtimeArg);
const node = path.join(runtime, "bin/node");
const packageRoot = path.join(runtime, "lib/node_modules/openclaw");
const expected = JSON.parse(fs.readFileSync(expectedInfoPath, "utf8"));
const actual = JSON.parse(fs.readFileSync(path.join(packageRoot, "dist/build-info.json"), "utf8"));
for (const key of ["version", "commit", "builtAt", "buildId"]) {
  if (!expected[key] || expected[key] !== actual[key]) {
    throw new Error(`Private worker build mismatch: ${key}`);
  }
}
if (fs.realpathSync(process.execPath) !== node) {
  throw new Error("Worker proof must execute the bundled Node for the requested architecture");
}

const inside = (candidate) => candidate === runtime || candidate.startsWith(`${runtime}/`);
const systemLibrary = (candidate) =>
  candidate.startsWith("/usr/lib/") || candidate.startsWith("/System/Library/");
function expandLoaderPath(value, filename) {
  return value
    .replace(/^@loader_path(?=\/|$)/u, path.dirname(filename))
    .replace(/^@executable_path(?=\/|$)/u, path.dirname(node));
}
function loadCommands(filename) {
  const output = execFileSync("/usr/bin/otool", ["-l", filename], { encoding: "utf8" });
  return output.split(/Load command \d+\n/u).flatMap((block) => {
    const command = /^\s*cmd (LC_\w+)$/mu.exec(block)?.[1];
    // LC_ID_DYLIB is an install ID, not a file the loader will open.
    if (!command || !/^LC_(?:LOAD.*DYLIB|REEXPORT_DYLIB|RPATH)$/u.test(command)) {
      return [];
    }
    const value = /^\s*(?:name|path) (.+) \(offset \d+\)$/mu.exec(block)?.[1];
    if (!value) {
      throw new Error(`Unreadable native load command in ${filename}`);
    }
    return [{ command, value }];
  });
}
const nodeRpaths = loadCommands(node).filter(({ command }) => command === "LC_RPATH");
let nativeFiles = 0;
function auditDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!inside(fs.realpathSync(filename))) {
        throw new Error(`Worker symlink escapes bundle: ${filename}`);
      }
    } else if (entry.isDirectory()) {
      auditDirectory(filename);
    } else if (entry.isFile()) {
      // Read just the magic before calling otool; the complete package also
      // intentionally carries Linux/Windows prebuilds and other Mac slices.
      const fd = fs.openSync(filename, "r");
      const magic = Buffer.alloc(4);
      try {
        fs.readSync(fd, magic, 0, 4, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (
        !["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(
          magic.toString("hex"),
        )
      ) {
        continue;
      }
      nativeFiles++;
      const commands = loadCommands(filename);
      const rpaths = [...nodeRpaths, ...commands.filter(({ command }) => command === "LC_RPATH")];
      for (const { command, value } of commands) {
        const candidates = value.startsWith("@rpath/")
          ? rpaths.map(({ value: prefix }) =>
              path.join(expandLoaderPath(prefix, filename), value.slice(7)),
            )
          : [expandLoaderPath(value, filename)];
        if (
          !candidates.some(
            (candidate) =>
              systemLibrary(candidate) ||
              (path.isAbsolute(candidate) &&
                inside(path.resolve(candidate)) &&
                fs.existsSync(candidate) &&
                inside(fs.realpathSync(candidate))),
          )
        ) {
          throw new Error(`Nonportable ${command} in ${filename}: ${value}`);
        }
      }
    }
  }
}
auditDirectory(runtime);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-proof-"));
try {
  // Ready manifests do not load lazy native capabilities. Exercise their real
  // package loaders so omitted optional packages and wrong slices fail staging.
  const require = createRequire(path.join(packageRoot, "package.json"));
  const { configureFsSafeNative } = await import(
    pathToFileURL(require.resolve("@openclaw/fs-safe/config")).href
  );
  const { sha256File } = await import(
    pathToFileURL(require.resolve("@openclaw/fs-safe/durability")).href
  );
  configureFsSafeNative({ mode: "require" });
  const proofFile = path.join(home, "native-proof");
  const content = "bundled worker native proof\n";
  fs.writeFileSync(proofFile, content);
  assert.deepEqual(await sha256File(proofFile), {
    bytes: Buffer.byteLength(content),
    digest: createHash("sha256").update(content).digest("hex"),
  });
  const database = new DatabaseSync(":memory:", { allowExtension: true });
  try {
    require("sqlite-vec").load(database);
    assert.equal(
      typeof database.prepare("SELECT vec_version() AS version").get().version,
      "string",
    );
  } finally {
    database.close();
  }
  await new Promise((resolve, reject) => {
    const terminal = require("@lydell/node-pty").spawn(
      "/bin/sh",
      ["-c", "printf worker-pty-proof"],
      {
        cwd: home,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        name: "xterm",
        cols: 80,
        rows: 24,
      },
    );
    let output = "";
    const timeout = setTimeout(() => {
      terminal.kill("SIGKILL");
      reject(new Error("Bundled PTY did not exit"));
    }, 10_000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0 && output === "worker-pty-proof") {
        resolve();
      } else {
        reject(new Error(`Bundled PTY failed (${exitCode}): ${output}`));
      }
    });
  });
  let ready = false;
  let failure;
  let diagnostic = "";
  const exitCode = await runManagedCommand({
    bin: node,
    args: [path.join(packageRoot, "dist/entry.js"), "node", "worker"],
    cwd: home,
    env: {
      HOME: home,
      TMPDIR: home,
      PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      OPENCLAW_NODE_EXEC_HOST: "app",
      OPENCLAW_NODE_EXEC_FALLBACK: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs: 300_000,
    requireProcessTreeExit: true,
    onReady(child) {
      const lines = createInterface({ input: child.stdout });
      child.stderr.on("data", (data) => {
        diagnostic = (diagnostic + data.toString()).slice(0, 4000);
      });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type !== "ready") {
          return;
        }
        if (
          message.version !== expected.version ||
          !message.manifest?.commands?.includes("system.run") ||
          !message.manifest?.commands?.includes("system.which")
        ) {
          failure = new Error("Bundled worker returned an incompatible capability manifest");
          terminateManagedChild(child, "SIGKILL");
          return;
        }
        ready = true;
        process.stdout.write(
          `${JSON.stringify({ architecture: process.arch, build: actual, nativeFiles, manifest: message.manifest })}\n`,
        );
        child.stdin.end('{"type":"stop"}\n');
      });
      child.on("close", () => lines.close());
      child.stdin.on("error", (error) => {
        failure = error;
        terminateManagedChild(child, "SIGKILL");
      });
    },
  });
  if (failure || !ready || exitCode !== 0) {
    throw (
      failure ??
      new Error(`Bundled worker failed before clean shutdown (${exitCode}): ${diagnostic}`)
    );
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
