import { resolveStateDir } from "../../config/paths.js";
import type { PluginRuntime } from "./types.js";

/** The registry proxy binds stores to a trusted plugin; the base facade owns no storage. */
export function createRuntimeState(): PluginRuntime["state"] {
  const unavailable = (method: string) => () => {
    throw new Error(`${method} is only available through the plugin runtime proxy.`);
  };
  return {
    resolveStateDir,
    openBlobStore: unavailable("openBlobStore"),
    openKeyedStore: unavailable("openKeyedStore"),
    openSyncKeyedStore: unavailable("openSyncKeyedStore"),
    openChannelIngressQueue: unavailable("openChannelIngressQueue"),
    openChannelIngressDrain: unavailable("openChannelIngressDrain"),
  };
}
