import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import {
  clearPluginModuleLoaderLifecycleCache,
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
} from "./plugin-module-loader-cache.js";
import { installOpenClawPluginSdkNativeResolver } from "./plugin-sdk-native-resolver.js";

const roots: string[] = [];
const requireFixture = createRequire(import.meta.url);

function writeFile(root: string, name: string, content: string) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lazy-alias-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "extensions"));
  writeFile(
    root,
    "package.json",
    JSON.stringify({
      name: "openclaw",
      type: "module",
      bin: { openclaw: "./openclaw.mjs" },
      exports: {
        "./plugin-sdk/used": "./dist/plugin-sdk/used.js",
        "./plugin-sdk/unused": "./dist/plugin-sdk/unused.js",
      },
    }),
  );
  const used = writeFile(root, "dist/plugin-sdk/used.js", 'export const value = "dist";');
  const unused = writeFile(root, "dist/plugin-sdk/unused.js", 'export const value = "unused";');
  writeFile(root, "src/plugin-sdk/used.ts", 'export const value: string = "source";');
  const entry = writeFile(
    root,
    "dist/extensions/demo/cli-metadata.cjs",
    'module.exports = { marker: "metadata", load: (name) => require(name), loadEsm: (name) => import(name) };',
  );
  return { root, entry, used, unused };
}

function fallbackFixture(extension = "cjs") {
  const f = fixture();
  const marker = `openclaw.fallback:${f.root}`;
  const counter = { count: 0 };
  vi.stubGlobal(marker, counter);
  writeFile(f.root, "plugin/package.json", '{"type":"commonjs"}');
  const entry = writeFile(
    f.root,
    `plugin/index.${extension}`,
    `globalThis[${JSON.stringify(marker)}].count += 1;
const dep = require("./dep.js");
module.exports = { value: dep.value };`,
  );
  writeFile(f.root, "plugin/dep.ts", 'export const value: string = "typescript-dependency";');
  const params = {
    modulePath: entry,
    loaderFilename: entry,
    importerUrl: pathToFileURL(path.join(f.root, "src/plugins/loader.js")).href,
    argvEntry: path.join(f.root, "openclaw.mjs"),
    devSourceRoot: f.root,
  };
  return { ...f, entry, params, count: () => counter.count };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    for (const id of Object.keys(requireFixture.cache)) {
      if (id.startsWith(`${root}${path.sep}`)) {
        delete requireFixture.cache[id];
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("native plugin alias preparation", () => {
  it.each([
    { moduleCache: undefined, extension: "cjs" },
    { moduleCache: "false", extension: "cjs" },
    { moduleCache: undefined, extension: "js" },
    { moduleCache: "false", extension: "js" },
  ])(
    "retains fallback exports across acquisitions: $extension moduleCache=$moduleCache",
    (mode) => {
      vi.stubEnv("JITI_MODULE_CACHE", mode.moduleCache);
      const f = fallbackFixture(mode.extension);
      const cache = createPluginModuleLoaderCache();
      expect(() => createRequire(f.entry).resolve("./dep.js")).toThrow(/Cannot find module/);
      const first = getCachedPluginModuleLoader({ ...f.params, cache })(f.entry);
      expect(first).toMatchObject({ value: "typescript-dependency" });
      const initialized = f.count();
      expect(initialized).toBeGreaterThan(0);
      for (let acquisition = 0; acquisition < 2; acquisition += 1) {
        const result = getCachedPluginModuleLoader({ ...f.params, cache })(f.entry);
        expect.soft(f.count()).toBe(initialized);
        expect.soft(result).toBe(first);
      }
    },
  );

  it.each([undefined, "false"])(
    "keeps explicit fallback records content-keyed with moduleCache=%s",
    (moduleCache) => {
      vi.stubEnv("JITI_MODULE_CACHE", moduleCache);
      const f = fallbackFixture();
      const params = { ...f.params, cache: createPluginModuleLoaderCache() };
      const first = getCachedPluginModuleLoader({
        ...params,
        aliasMap: { chosen: f.used, other: f.unused },
      })(f.entry);
      const initialized = f.count();
      expect(
        getCachedPluginModuleLoader({
          ...params,
          aliasMap: { other: f.unused, chosen: f.used },
        })(f.entry),
      ).toBe(first);
      expect(f.count()).toBe(initialized);
      expect(
        getCachedPluginModuleLoader({
          ...params,
          aliasMap: { other: f.unused, chosen: f.unused },
        }),
      ).not.toBe(
        getCachedPluginModuleLoader({
          ...params,
          aliasMap: { chosen: f.used, other: f.unused },
        }),
      );
      expect(params.cache.size).toBe(2);
    },
  );

  it.each([undefined, "false"])(
    "retains fallback exports through the runtime loader with moduleCache=%s",
    (moduleCache) => {
      vi.stubEnv("JITI_MODULE_CACHE", moduleCache);
      const f = fallbackFixture();
      const load = createPluginModuleLoader({ devSourceRoot: f.root });
      const first = load(f.entry);
      const initialized = f.count();
      expect(first).toMatchObject({ value: "typescript-dependency" });
      expect(load(f.entry)).toBe(first);
      expect(f.count()).toBe(initialized);
    },
  );

  it("evicts fallback owners at capacity and clears their native lifecycle", () => {
    vi.stubEnv("JITI_MODULE_CACHE", "false");
    const fixtures = [fallbackFixture(), fallbackFixture(), fallbackFixture()] as const;
    const [a, b, c] = fixtures;
    const cache = createPluginModuleLoaderCache(2);
    const acquire = (f: ReturnType<typeof fallbackFixture>) =>
      getCachedPluginModuleLoader({ ...f.params, cache })(f.entry);
    const first = acquire(a);
    const second = acquire(b);
    const initialized = a.count();
    expect(acquire(a)).toBe(first);
    acquire(c);
    expect(cache.size).toBe(2);
    expect(acquire(a)).toBe(first);
    expect(a.count()).toBe(initialized);
    expect(acquire(b)).not.toBe(second);
    expect(b.count()).toBeGreaterThan(initialized);
    const moduleRoots = new Map(fixtures.map((f) => [f.entry, path.dirname(f.entry)]));
    clearPluginModuleLoaderLifecycleCache({ moduleLoaders: cache, moduleRoots });
    expect(cache.size).toBe(0);
    expect(moduleRoots.size).toBe(0);
    expect(acquire(a)).not.toBe(first);
    expect(a.count()).toBeGreaterThan(initialized);
  });

  it.each([undefined, "false"])(
    "clears successful fallback state with moduleCache=%s",
    (moduleCache) => {
      vi.stubEnv("JITI_MODULE_CACHE", moduleCache);
      const f = fallbackFixture();
      const cache = createPluginModuleLoaderCache();
      const acquire = () => getCachedPluginModuleLoader({ ...f.params, cache })(f.entry);
      const first = acquire();
      const initialized = f.count();
      clearPluginModuleLoaderLifecycleCache({
        moduleLoaders: cache,
        moduleRoots: new Map([[f.entry, path.dirname(f.entry)]]),
      });
      expect(acquire()).not.toBe(first);
      expect(f.count()).toBeGreaterThan(initialized);
      const reinitialized = f.count();
      acquire();
      expect(f.count()).toBe(reinitialized);
    },
  );

  it("separates captured SDK hosts and effective source orders in one caller cache", () => {
    const a = fixture();
    const b = fixture();
    writeFile(b.root, "dist/plugin-sdk/used.js", 'export const value = "other-host";');
    vi.stubEnv("JITI_MODULE_CACHE", "false");
    const entry = writeFile(
      a.root,
      "external/index.ts",
      'import { value } from "@openclaw/plugin-sdk/used"; export const marker: string = value;',
    );
    const params = {
      cache: createPluginModuleLoaderCache(),
      modulePath: entry,
      importerUrl: pathToFileURL(path.join(a.root, "src/plugins/loader.js")).href,
      devSourceRoot: a.root,
      tryNative: false,
    };
    const source = getCachedPluginModuleLoader({ ...params, pluginSdkResolution: "src" })(entry);
    const dist = getCachedPluginModuleLoader({ ...params, pluginSdkResolution: "dist" })(entry);
    const other = getCachedPluginModuleLoader({
      ...params,
      pluginSdkResolution: "dist",
      devSourceRoot: b.root,
    })(entry);
    expect(source).toMatchObject({ marker: "source" });
    expect(dist).toMatchObject({ marker: "dist" });
    expect(other).toMatchObject({ marker: "other-host" });
    vi.stubEnv("NODE_ENV", "production");
    expect(getCachedPluginModuleLoader(params)(entry)).toBe(dist);
    expect(params.cache.size).toBe(3);
  });

  it.each([
    { subpath: "qa-runtime", owner: "qa" },
    { subpath: "demoted-helper", owner: "bundled" },
    { subpath: "ssrf-runtime-internal", owner: "trusted" },
  ])(
    "separates captured $owner authority before reusing a successful export",
    ({ subpath, owner }) => {
      const f = fixture();
      vi.stubEnv("JITI_MODULE_CACHE", "false");
      vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", owner === "qa" ? "1" : "0");
      writeFile(
        f.root,
        "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
        JSON.stringify([subpath]),
      );
      writeFile(f.root, `dist/plugin-sdk/${subpath}.js`, "export const privateValue = true;");
      const entry = writeFile(
        f.root,
        "external/index.ts",
        `import { privateValue } from "@openclaw/plugin-sdk/${subpath}"; export { privateValue };`,
      );
      const params = {
        cache: createPluginModuleLoaderCache(),
        loaderFilename: entry,
        modulePath:
          owner === "qa"
            ? entry
            : path.join(
                f.root,
                "dist/extensions",
                owner === "trusted" ? "ollama" : "demo",
                "index.js",
              ),
        importerUrl: pathToFileURL(path.join(f.root, "src/plugins/loader.js")).href,
        devSourceRoot: f.root,
        pluginSdkResolution: "dist" as const,
        tryNative: false,
      };
      const allowed = getCachedPluginModuleLoader(params)(entry);
      expect(allowed).toMatchObject({ privateValue: true });
      vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
      const deniedModule =
        owner === "trusted" ? path.join(f.root, "dist/extensions/demo/index.js") : entry;
      expect(() =>
        getCachedPluginModuleLoader({ ...params, modulePath: deniedModule })(entry),
      ).toThrow();
      if (owner !== "qa") {
        expect(getCachedPluginModuleLoader(params)(entry)).toBe(allowed);
      }
    },
  );

  it.each([
    { dimension: "filename", override: { loaderFilename: "alternate" } },
    { dimension: "native", override: { tryNative: false } },
    { dimension: "dependency transformation", override: { transformOpenClawDependencies: false } },
    { dimension: "caller scope", override: { cacheScopeKey: "alternate" } },
  ])("separates implicit fallback owners by $dimension", ({ dimension, override }) => {
    vi.stubEnv("JITI_MODULE_CACHE", "false");
    const f = fallbackFixture();
    const params = { ...f.params, cache: createPluginModuleLoaderCache() };
    const first = getCachedPluginModuleLoader(params)(f.entry);
    const different = {
      ...params,
      ...override,
      ...(dimension === "filename" ? { loaderFilename: path.join(f.root, "alternate.js") } : {}),
    };
    expect(getCachedPluginModuleLoader(different)(f.entry)).not.toBe(first);
    const initialized = f.count();
    expect(getCachedPluginModuleLoader(params)(f.entry)).toBe(first);
    expect(f.count()).toBe(initialized);
    expect(params.cache.size).toBe(2);
  });

  it.each(["shared", ""])(
    "preserves the explicit shared-scope override %j",
    (sharedCacheScopeKey) => {
      vi.stubEnv("JITI_MODULE_CACHE", "false");
      const f = fallbackFixture();
      const params = { ...f.params, cache: createPluginModuleLoaderCache(), sharedCacheScopeKey };
      const first = getCachedPluginModuleLoader(params)(f.entry);
      const initialized = f.count();
      expect(
        getCachedPluginModuleLoader({
          ...params,
          aliasMap: { changed: f.used },
          cacheScopeKey: "different",
          tryNative: false,
          transformOpenClawDependencies: false,
        })(f.entry),
      ).toBe(first);
      expect(f.count()).toBe(initialized);
      expect(params.cache.size).toBe(1);
    },
  );

  it("loads alias-free compiled metadata without reading unused SDK artifacts", () => {
    const f = fixture();
    const read = vi.spyOn(fs, "readFileSync");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    const metadata = load(f.entry);
    expect(metadata).toMatchObject({ marker: "metadata" });
    expect(load(f.entry)).toBe(metadata);
    expect(read.mock.calls.filter(([target]) => target === f.used || target === f.unused)).toEqual(
      [],
    );
  });

  it("prepares the complete map once on a late alias request and reuses it for CJS and ESM", async () => {
    const f = fixture();
    const read = vi.spyOn(fs, "readFileSync");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    const metadata = load(f.entry) as {
      load: (name: string) => unknown;
      loadEsm: (name: string) => Promise<unknown>;
    };
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
    expect(metadata.load("openclaw/plugin-sdk/used")).toMatchObject({ value: "dist" });
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toHaveLength(1);
    expect(await metadata.loadEsm("@openclaw/plugin-sdk/used.js")).toMatchObject({ value: "dist" });
    expect(createRequire(f.entry).resolve("openclaw/plugin-sdk/unused")).toBe(f.unused);
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toHaveLength(1);
  });

  it.each(["cjs", "mjs"])(
    "prepares all aliases before evaluating an alias-using %s target",
    (extension) => {
      const f = fixture();
      const entry = writeFile(
        f.root,
        `dist/extensions/demo/eager.${extension}`,
        extension === "cjs"
          ? 'module.exports = require("@openclaw/plugin-sdk/used");'
          : 'export { value } from "@openclaw/plugin-sdk/used";',
      );
      const read = vi.spyOn(fs, "readFileSync");
      const load = createPluginModuleLoader({ devSourceRoot: f.root });
      expect(load(entry)).toMatchObject({ value: "dist" });
      expect(load(entry)).toBe(load(entry));
      expect(read.mock.calls.filter(([target]) => target === f.unused)).toHaveLength(1);
    },
  );

  it.each([
    { specifier: "@openclaw/retry", target: "dist/retry/index.js" },
    {
      specifier: "@openclaw/fixture-owner/diagnostic-api.js",
      target: "dist/extensions/fixture-owner/diagnostic-api.js",
    },
  ])("defers the full map for the $specifier alias family", ({ specifier, target: artifact }) => {
    const f = fixture();
    writeFile(f.root, artifact, 'export const value = "family";');
    writeFile(
      f.root,
      "extensions/fixture-owner/package.json",
      JSON.stringify({ name: "@openclaw/fixture-owner" }),
    );
    writeFile(
      f.root,
      "extensions/fixture-owner/diagnostic-api.ts",
      'export const value = "source";',
    );
    const entry = writeFile(
      f.root,
      "dist/extensions/demo/family.cjs",
      `module.exports = require(${JSON.stringify(specifier)});`,
    );
    const read = vi.spyOn(fs, "readFileSync");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    expect(load(f.entry)).toMatchObject({ marker: "metadata" });
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
    expect(load(entry)).toMatchObject({ value: "family" });
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toHaveLength(1);
  });

  it("does not prepare aliases for unrelated requests or unregistered parents", () => {
    const f = fixture();
    const outside = fixture();
    const read = vi.spyOn(fs, "readFileSync");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    const metadata = load(f.entry) as { load: (name: string) => unknown };
    expect(metadata.load("node:path")).toHaveProperty("join");
    expect(() => metadata.load("@openclaw/plugin-sdk-other/used")).toThrow();
    expect(() => metadata.load("@openclaw/not-a-workspace/used")).toThrow();
    expect(() => createRequire(outside.entry).resolve("@openclaw/plugin-sdk/used")).toThrow();
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
  });

  it.each([false, true])(
    "pins a native host across ambient changes and replaces a resolved=%s provider",
    (resolveFirst) => {
      const a = fixture();
      const b = fixture();
      const entry = writeFile(
        a.root,
        "external/package.json",
        JSON.stringify({ name: "fixture-external" }),
      );
      const pluginEntry = writeFile(path.dirname(entry), "index.cjs", "module.exports = {};");
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", a.root);
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: pluginEntry });
      const requirePlugin = createRequire(pluginEntry);
      if (resolveFirst) {
        expect(requirePlugin.resolve("@openclaw/plugin-sdk/used")).toBe(a.used);
      }
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", b.root);
      vi.spyOn(process, "cwd").mockReturnValue(b.root);
      const argv = vi
        .spyOn(process, "argv", "get")
        .mockReturnValue([process.execPath, path.join(b.root, "openclaw.mjs")]);
      expect(requirePlugin.resolve("@openclaw/plugin-sdk/used")).toBe(a.used);
      // Removal is from a new host snapshot, not an in-place artifact freshness poll.
      fs.rmSync(b.unused);
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: pluginEntry });
      expect(requirePlugin.resolve("@openclaw/plugin-sdk/used")).toBe(b.used);
      expect(() => requirePlugin.resolve("@openclaw/plugin-sdk/unused")).toThrow();
      argv.mockRestore();
    },
  );

  it.each(["argv", "cwd", "module-url"])(
    "captures the %s host hint before source loading",
    (hint) => {
      const a = fixture();
      const b = fixture();
      const external = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-alias-external-")),
      );
      roots.push(external);
      const entry = writeFile(
        external,
        "index.ts",
        'import { value } from "@openclaw/plugin-sdk/used"; export const marker: string = value;',
      );
      writeFile(a.root, "src/plugin-sdk/used.ts", 'export const value = "host-a";');
      writeFile(b.root, "src/plugin-sdk/used.ts", 'export const value = "host-b";');
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", "");
      vi.stubEnv("JITI_FS_CACHE", "false");
      vi.stubEnv("NODE_ENV", "development");
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(hint === "cwd" ? a.root : external);
      const argv = vi
        .spyOn(process, "argv", "get")
        .mockReturnValue([
          process.execPath,
          hint === "argv" ? path.join(a.root, "openclaw.mjs") : "",
        ]);
      const loader = getCachedPluginModuleLoader({
        cache: new Map(),
        modulePath: entry,
        tryNative: false,
        importerUrl: pathToFileURL(
          path.join(hint === "module-url" ? a.root : external, "loader.js"),
        ).href,
      });
      cwd.mockReturnValue(b.root);
      argv.mockReturnValue([process.execPath, path.join(b.root, "openclaw.mjs")]);
      expect(loader(entry)).toMatchObject({ marker: "host-a" });
    },
  );

  it("captures private QA denial before late use even if ambient authorization changes", () => {
    const f = fixture();
    writeFile(
      f.root,
      "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
      JSON.stringify(["qa-runtime"]),
    );
    writeFile(f.root, "dist/plugin-sdk/qa-runtime.js", "export const privateValue = true;");
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
    const load = createPluginModuleLoader({ devSourceRoot: f.root });
    const metadata = load(f.entry) as { load: (name: string) => unknown };
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
    expect(() => metadata.load("@openclaw/plugin-sdk/qa-runtime")).toThrow();
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root });
    expect(metadata.load("@openclaw/plugin-sdk/qa-runtime")).toMatchObject({ privateValue: true });
  });

  it("retires an unused pending provider on explicit reinstall", () => {
    const a = fixture();
    const b = fixture();
    const read = vi.spyOn(fs, "readFileSync");
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: a.entry, devSourceRoot: a.root });
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: a.entry, devSourceRoot: b.root });
    expect(createRequire(a.entry).resolve("@openclaw/plugin-sdk/used")).toBe(b.used);
    expect(read.mock.calls.filter(([target]) => target === a.unused)).toEqual([]);
    expect(read.mock.calls.filter(([target]) => target === b.unused)).toHaveLength(1);
  });

  it("does not reuse a bundled private alias grant for an external plugin", () => {
    const f = fixture();
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
    writeFile(
      f.root,
      "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
      JSON.stringify(["demoted-helper"]),
    );
    writeFile(f.root, "dist/plugin-sdk/demoted-helper.js", "export const privateValue = true;");
    const external = writeFile(f.root, "external/index.cjs", "module.exports = {};");
    writeFile(f.root, "external/package.json", JSON.stringify({ name: "external-fixture" }));
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: f.entry, devSourceRoot: f.root });
    expect(createRequire(f.entry)("@openclaw/plugin-sdk/demoted-helper")).toMatchObject({
      privateValue: true,
    });
    installOpenClawPluginSdkNativeResolver({ pluginModulePath: external, devSourceRoot: f.root });
    expect(() => createRequire(external).resolve("@openclaw/plugin-sdk/demoted-helper")).toThrow();
  });

  it.each([false, true])(
    "captures private owner authorization=%s before a package rename",
    (authorized) => {
      const f = fixture();
      vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "0");
      const packageName = "@openclaw/llama-cpp-provider";
      const packageRoot = path.join(f.root, "node_modules", packageName);
      const manifest = writeFile(
        packageRoot,
        "package.json",
        JSON.stringify({ name: authorized ? packageName : "external-fixture" }),
      );
      const entry = writeFile(packageRoot, "index.cjs", "module.exports = {};");
      const target = writeFile(
        f.root,
        "dist/plugin-sdk/ssrf-runtime-internal.js",
        "export const privateValue = true;",
      );
      installOpenClawPluginSdkNativeResolver({ pluginModulePath: entry, devSourceRoot: f.root });
      fs.writeFileSync(
        manifest,
        JSON.stringify({ name: authorized ? "external-fixture" : packageName }),
      );
      const resolve = () =>
        createRequire(entry).resolve("@openclaw/plugin-sdk/ssrf-runtime-internal");
      if (authorized) {
        expect(resolve()).toBe(target);
      } else {
        expect(resolve).toThrow();
      }
    },
  );

  it.each([false, true])(
    "captures source preference before transformer use, stale dist=%s",
    (staleDist) => {
      const a = fixture();
      const b = fixture();
      vi.stubEnv("JITI_FS_CACHE", "false");
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", a.root);
      vi.stubEnv("NODE_ENV", staleDist ? "production" : "development");
      if (staleDist) {
        fs.writeFileSync(a.used, 'export { value } from "./missing.js";');
      }
      const entry = writeFile(
        a.root,
        "extensions/demo/transform.ts",
        'import { value } from "@openclaw/plugin-sdk/used"; export const marker: string = value;',
      );
      const cache = new Map();
      const read = vi.spyOn(fs, "readFileSync");
      const loader = getCachedPluginModuleLoader({
        cache,
        modulePath: entry,
        importerUrl: import.meta.url,
        tryNative: false,
      });
      expect(read.mock.calls.filter(([target]) => target === a.unused)).toEqual([]);
      vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", b.root);
      vi.stubEnv("NODE_ENV", "production");
      expect(loader(entry)).toMatchObject({ marker: "source" });
      expect(
        read.mock.calls.filter(([target]) => target === b.used || target === b.unused),
      ).toEqual([]);
      expect(loader(entry)).toBe(loader(entry));
      expect(cache.size).toBe(1);
    },
  );

  it("keeps explicit records content-keyed without preparing an implicit SDK map", () => {
    const f = fixture();
    const entry = writeFile(
      f.root,
      "dist/extensions/demo/explicit.cjs",
      'module.exports = require("chosen");',
    );
    const read = vi.spyOn(fs, "readFileSync");
    const cache = new Map();
    const params = {
      cache,
      modulePath: entry,
      importerUrl: import.meta.url,
      devSourceRoot: f.root,
    };
    const a = getCachedPluginModuleLoader({
      ...params,
      aliasMap: { chosen: f.used, other: f.unused },
    });
    const b = getCachedPluginModuleLoader({
      ...params,
      aliasMap: { other: f.unused, chosen: f.used },
    });
    expect(b).toBe(a);
    expect(a(entry)).toMatchObject({ value: "dist" });
    expect(b(entry)).toBe(a(entry));
    expect(read.mock.calls.filter(([target]) => target === f.unused)).toEqual([]);
  });
});
