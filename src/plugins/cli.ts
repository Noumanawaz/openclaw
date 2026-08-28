// Registers plugin-related CLI commands.
import type { Command } from "commander";
import {
  getRuntimeConfigSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginCliLogger,
  createPluginCliLoadSession,
  loadPluginCliRegistrationEntriesWithDefaults,
  type PluginCliLoadSession,
  type PluginCliLoaderOptions,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandGroups } from "./register-plugin-cli-command-groups.js";
export { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";

type PluginCliRegistrationMode = "eager" | "lazy";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
  primary?: string | null;
  skipPluginValidation?: boolean;
  session?: PluginCliLoadSession;
};

const logger = createPluginCliLogger();

export const loadValidatedConfigForPluginRegistration = async (options?: {
  skipPluginValidation?: boolean;
  session?: PluginCliLoadSession;
}): Promise<OpenClawConfig | null> => {
  const read = () =>
    readConfigFileSnapshotWithPluginMetadata({
      skipPluginValidation: options?.skipPluginValidation,
      allowCurrentPluginMetadata: false,
    });
  const { snapshot } = options?.session ? await options.session.readConfig(read) : await read();
  if (!snapshot.valid) {
    return null;
  }
  return getRuntimeConfigSnapshot() ?? snapshot.runtimeConfig;
};

export async function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
) {
  const mode = options?.mode ?? "eager";
  const primary = options?.primary ?? undefined;
  const session = options?.session ?? createPluginCliLoadSession();
  try {
    const entries = await loadPluginCliRegistrationEntriesWithDefaults({
      cfg,
      env,
      loaderOptions,
      primaryCommand: primary,
      session,
    });

    const groups = entries.map((entry) => {
      if (
        mode !== "lazy" ||
        (primary &&
          (entry.parentPath[0] === primary ||
            entry.names.includes(primary) ||
            entry.placeholders.some((descriptor) => descriptor.name === primary)))
      ) {
        return entry;
      }
      // Deferred tree expansion is a separate operation. Never retain startup registrars
      // past close, including help/completion parses on a previously prepared program.
      return Object.assign({}, entry, {
        register: async (target: Command) => {
          const deferred = createPluginCliLoadSession();
          try {
            const fresh = await loadPluginCliRegistrationEntriesWithDefaults({
              cfg,
              env,
              loaderOptions,
              session: deferred,
            });
            const match = fresh.find(
              (candidate) =>
                candidate.pluginId === entry.pluginId &&
                candidate.parentPath.join("\0") === entry.parentPath.join("\0") &&
                candidate.names.join("\0") === entry.names.join("\0"),
            );
            if (!match) {
              throw new Error(
                `Plugin CLI registration is no longer available (${entry.pluginId}).`,
              );
            }
            await match.register(target);
          } finally {
            deferred.close();
          }
        },
      });
    });
    await registerPluginCliCommandGroups(program, groups, {
      mode,
      primary,
      // Include aliases: alias-only root names (cron|automations, tui|terminal)
      // are owned commands too; a plugin claiming one would crash registration.
      existingCommands: new Set(program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()])),
      logger,
    });
  } finally {
    if (!options?.session) {
      session.close();
    }
  }
}

export async function registerPluginCliCommandsFromValidatedConfig(
  program: Command,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: PluginCliLoaderOptions,
  options?: RegisterPluginCliOptions,
): Promise<OpenClawConfig | null> {
  const session = options?.session ?? createPluginCliLoadSession();
  try {
    const config = await loadValidatedConfigForPluginRegistration({
      skipPluginValidation: options?.skipPluginValidation,
      session,
    });
    if (!config) {
      return null;
    }
    await registerPluginCliCommands(program, config, env, loaderOptions, { ...options, session });
    return config;
  } finally {
    if (!options?.session) {
      session.close();
    }
  }
}
