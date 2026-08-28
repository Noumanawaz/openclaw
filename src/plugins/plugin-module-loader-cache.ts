/** Caches plugin module loaders and native-load stats for runtime/source module imports. */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { createJiti } from "jiti";
import { toSafeImportPath } from "../shared/import-specifier.js";
import {
  clearNativeRequireJavaScriptModuleCache,
  tryNativeRequireJavaScriptModule,
} from "./native-module-require.js";
import { PluginLruCache } from "./plugin-cache-primitives.js";
import { installOpenClawInternalCorePackageNativeResolver } from "./plugin-sdk-native-resolver.js";
import {
  buildPluginLoaderJitiOptions,
  createPluginLoaderModuleCacheKey,
  preparePluginLoaderAliases,
  resolvePluginLoaderTryNative,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

/** Jiti-based module loader used for plugin source/runtime imports. */
type PluginModuleLoader = (target: string) => unknown;
export type PluginModuleLoaderFactory = typeof createJiti;
export type PluginModuleLoaderCache = Pick<
  PluginLruCache<PluginModuleLoader>,
  "clear" | "get" | "set" | "size"
>;
type ResolvePluginModuleLoaderCacheEntryParams = {
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  loaderFilename?: string;
  aliasMap?: Record<string, string>;
  tryNative?: boolean;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cacheScopeKey?: string;
  sharedCacheScopeKey?: string;
  transformOpenClawDependencies?: boolean;
};
type PluginModuleLoaderStatsSnapshot = {
  calls: number;
  nativeHits: number;
  nativeMisses: number;
  sourceTransformForced: number;
  sourceTransformFallbacks: number;
  topSourceTransformTargets: Array<{ target: string; count: number }>;
};

const DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES = 128;
const MAX_TRACKED_SOURCE_TRANSFORM_TARGETS = 24;
const requireForJiti = createRequire(import.meta.url);
let createJitiLoaderFactory: PluginModuleLoaderFactory | undefined;
const pluginModuleLoaderStats = {
  calls: 0,
  nativeHits: 0,
  nativeMisses: 0,
  sourceTransformForced: 0,
  sourceTransformFallbacks: 0,
  sourceTransformTargets: new Map<string, number>(),
};

function recordSourceTransformTarget(target: string): void {
  const current = pluginModuleLoaderStats.sourceTransformTargets.get(target) ?? 0;
  pluginModuleLoaderStats.sourceTransformTargets.set(target, current + 1);
  if (pluginModuleLoaderStats.sourceTransformTargets.size <= MAX_TRACKED_SOURCE_TRANSFORM_TARGETS) {
    return;
  }
  let leastUsedTarget: string | undefined;
  let leastUsedCount = Number.POSITIVE_INFINITY;
  for (const [candidate, count] of pluginModuleLoaderStats.sourceTransformTargets) {
    if (count < leastUsedCount) {
      leastUsedTarget = candidate;
      leastUsedCount = count;
    }
  }
  if (leastUsedTarget) {
    pluginModuleLoaderStats.sourceTransformTargets.delete(leastUsedTarget);
  }
}

/** Returns process-local plugin module loader stats for diagnostics and tests. */
export function getPluginModuleLoaderStats(): PluginModuleLoaderStatsSnapshot {
  return {
    calls: pluginModuleLoaderStats.calls,
    nativeHits: pluginModuleLoaderStats.nativeHits,
    nativeMisses: pluginModuleLoaderStats.nativeMisses,
    sourceTransformForced: pluginModuleLoaderStats.sourceTransformForced,
    sourceTransformFallbacks: pluginModuleLoaderStats.sourceTransformFallbacks,
    topSourceTransformTargets: [...pluginModuleLoaderStats.sourceTransformTargets]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([target, count]) => ({ target, count })),
  };
}

function loadCreateJitiLoaderFactory(): PluginModuleLoaderFactory {
  if (createJitiLoaderFactory) {
    return createJitiLoaderFactory;
  }
  const loaded = requireForJiti("jiti") as { createJiti?: PluginModuleLoaderFactory };
  if (typeof loaded.createJiti !== "function") {
    throw new Error("jiti module did not export createJiti");
  }
  createJitiLoaderFactory = loaded.createJiti;
  return createJitiLoaderFactory;
}

export function createPluginModuleLoaderCache(
  maxEntries = DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES,
): PluginModuleLoaderCache {
  return new PluginLruCache<PluginModuleLoader>(maxEntries);
}

/** Evicts loader closures and native modules, including bundled chunks hoisted into dist. */
export function clearPluginModuleLoaderLifecycleCache(params: {
  moduleLoaders: PluginModuleLoaderCache;
  moduleRoots: Map<string, string>;
}): void {
  params.moduleLoaders.clear();
  for (const [modulePath, rootDir] of params.moduleRoots) {
    const extensionsDir = path.basename(rootDir) === "extensions" ? rootDir : path.dirname(rootDir);
    const distDir = path.dirname(extensionsDir);
    const dependencyRoot =
      path.basename(extensionsDir) === "extensions" && path.basename(distDir) === "dist"
        ? distDir
        : rootDir;
    clearNativeRequireJavaScriptModuleCache(modulePath, { dependencyRoot });
  }
  params.moduleRoots.clear();
}

function toSourceTransformImportPath(specifier: string): string {
  if (process.platform === "win32" && path.isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return toSafeImportPath(specifier);
}

function createLazySourceTransformLoader(params: {
  loaderFilename: string;
  getAliasMap: () => Record<string, string>;
  transformOpenClawDependencies: boolean;
  createLoader?: PluginModuleLoaderFactory;
}): () => PluginModuleLoader {
  let loadWithSourceTransform: PluginModuleLoader | undefined;
  return () => {
    if (loadWithSourceTransform) {
      return loadWithSourceTransform;
    }
    const jitiOptions = buildPluginLoaderJitiOptions(params.getAliasMap(), {
      modulePath: params.loaderFilename,
    });
    const jitiLoader = (params.createLoader ?? loadCreateJitiLoaderFactory())(
      params.loaderFilename,
      {
        ...jitiOptions,
        // A declined native require can leave ESM dependencies in flight; the
        // fallback must transform the entry and its OpenClaw dependencies.
        nativeModules: params.transformOpenClawDependencies
          ? jitiOptions.nativeModules.filter((moduleName) => moduleName !== "openclaw")
          : jitiOptions.nativeModules,
        tryNative: false,
      },
    );
    loadWithSourceTransform = (target) => jitiLoader(toSourceTransformImportPath(target));
    return loadWithSourceTransform;
  };
}

function cacheModuleExports(load: PluginModuleLoader): PluginModuleLoader {
  const exports = new Map<string, unknown>();
  return (target) => {
    if (exports.has(target)) {
      return exports.get(target);
    }
    const result = load(target);
    exports.set(target, result);
    return result;
  };
}

function createPluginModuleLoader(params: {
  aliasMap: Record<string, string> | ((specifier: string) => string | undefined);
  tryNative: boolean;
  getLoadWithSourceTransform: () => PluginModuleLoader;
}): PluginModuleLoader {
  const { getLoadWithSourceTransform } = params;
  // When the caller has explicitly opted out of native loading, route every
  // target through jiti so caller-provided alias rewrites still apply.
  if (!params.tryNative) {
    return cacheModuleExports((target) => {
      pluginModuleLoaderStats.calls += 1;
      pluginModuleLoaderStats.sourceTransformForced += 1;
      recordSourceTransformTarget(target);
      return getLoadWithSourceTransform()(target);
    });
  }
  // Otherwise prefer native require() for already-compiled JS artifacts
  // (the bundled plugin public surfaces shipped in dist/). jiti's transform
  // pipeline provides no value for output that is already plain JS and adds
  // several seconds of per-load overhead on slower hosts. jiti still runs
  // for TS / TSX sources and for the small set of require(esm) /
  // async-module fallbacks `tryNativeRequireJavaScriptModule` declines to
  // handle.
  return cacheModuleExports((target) => {
    pluginModuleLoaderStats.calls += 1;
    const native = tryNativeRequireJavaScriptModule(target, {
      allowWindows: true,
      aliasMap: params.aliasMap,
      fallbackOnMissingDependency: true,
    });
    if (native.ok) {
      pluginModuleLoaderStats.nativeHits += 1;
      return native.moduleExport;
    }
    pluginModuleLoaderStats.nativeMisses += 1;
    pluginModuleLoaderStats.sourceTransformFallbacks += 1;
    recordSourceTransformTarget(target);
    return getLoadWithSourceTransform()(target);
  });
}

export function getCachedPluginModuleLoader(
  params: ResolvePluginModuleLoaderCacheEntryParams & {
    cache: PluginModuleLoaderCache;
    createLoader?: PluginModuleLoaderFactory;
  },
): PluginModuleLoader {
  const loaderFilename = toSafeImportPath(params.loaderFilename ?? params.modulePath);
  const aliasMap = params.aliasMap;
  const tryNative = params.tryNative ?? resolvePluginLoaderTryNative(params.modulePath, params);
  const aliases = aliasMap
    ? {
        getAliasMap: () => aliasMap,
        resolveAlias: (specifier: string) => aliasMap[specifier],
        get cacheKey() {
          return createPluginLoaderModuleCacheKey({ tryNative, aliasMap });
        },
      }
    : preparePluginLoaderAliases({
        modulePath: params.modulePath,
        argv1: params.argvEntry ?? process.argv[1],
        moduleUrl: params.importerUrl,
        devSourceRoot: params.devSourceRoot,
        pluginSdkResolution: params.pluginSdkResolution,
      });
  const { getAliasMap } = aliases;
  const { sharedCacheScopeKey, cacheScopeKey } = params;
  const transformOpenClawDependencies = params.transformOpenClawDependencies ?? tryNative;
  const getCacheKey = () => {
    if (sharedCacheScopeKey !== undefined) {
      return `${loaderFilename}::${sharedCacheScopeKey}`;
    }
    const contentKey = aliasMap
      ? aliases.cacheKey
      : `implicit\0${tryNative ? "native" : "transform"}\0${aliases.cacheKey}`;
    const cacheKey = `${contentKey}\0transform-openclaw=${transformOpenClawDependencies ? "1" : "0"}`;
    return `${loaderFilename}::${cacheScopeKey ? `${cacheScopeKey}::${cacheKey}` : cacheKey}`;
  };
  // Cache the owner above native attempts: a successful fallback must retain its
  // exports even when Jiti does not populate Node's require cache.
  const cacheKey = getCacheKey();
  const cached = params.cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  installOpenClawInternalCorePackageNativeResolver({ moduleUrl: params.importerUrl });
  const getLoadWithSourceTransform = createLazySourceTransformLoader({
    loaderFilename,
    getAliasMap,
    transformOpenClawDependencies,
    createLoader: params.createLoader,
  });
  const loader = createPluginModuleLoader({
    aliasMap: aliasMap ?? aliases.resolveAlias,
    tryNative,
    getLoadWithSourceTransform,
  });
  params.cache.set(cacheKey, loader);
  return loader;
}

export function getCachedPluginSourceModuleLoader(
  params: Omit<Parameters<typeof getCachedPluginModuleLoader>[0], "tryNative">,
): PluginModuleLoader {
  return getCachedPluginModuleLoader({
    ...params,
    tryNative: false,
  });
}
