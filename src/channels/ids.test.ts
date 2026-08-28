// Channel id tests cover identifier normalization and validation helpers.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withEnv } from "../test-utils/env.js";
import { findChatChannelLabel, normalizeChatChannelId } from "./ids.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(clearPluginMetadataLifecycleCaches);

describe("channel ids", () => {
  it("replaces runtime channel aliases at the metadata lifecycle boundary", () => {
    const root = tempDirs.make("openclaw-channel-ids-");
    const pluginDir = path.join(root, "fixture");
    fs.mkdirSync(pluginDir);
    withEnv(
      { OPENCLAW_BUNDLED_PLUGINS_DIR: root, OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
      () => {
        for (const id of ["first-fixture-chat", "second-fixture-chat"]) {
          fs.writeFileSync(
            path.join(pluginDir, "package.json"),
            JSON.stringify({ openclaw: { channel: { id, aliases: ["fixture-alias"] } } }),
          );
          clearPluginMetadataLifecycleCaches();
          expect(normalizeChatChannelId("fixture-alias")).toBe(id);
        }
        expect(normalizeChatChannelId("first-fixture-chat")).toBeNull();
      },
    );
  });
  it("normalizes built-in aliases + trims whitespace", () => {
    expect(normalizeChatChannelId(" imsg ")).toBe("imessage");
    expect(normalizeChatChannelId("gchat")).toBe("googlechat");
    expect(normalizeChatChannelId("google-chat")).toBe("googlechat");
    expect(normalizeChatChannelId("internet-relay-chat")).toBe("irc");
    expect(normalizeChatChannelId("telegram")).toBe("telegram");
    expect(normalizeChatChannelId("web")).toBeNull();
    expect(normalizeChatChannelId("nope")).toBeNull();
  });

  it.each([
    ["whatsapp", "WhatsApp"],
    ["imessage", "iMessage"],
    ["googlechat", "Google Chat"],
    [" imsg ", "iMessage"],
    ["GOOGLE-CHAT", "Google Chat"],
  ])("finds the exact generated label for %s", (channel, label) => {
    expect(findChatChannelLabel(channel)).toBe(label);
  });

  it("does not fall back to runtime metadata for unknown channels", () => {
    expect(findChatChannelLabel("external-chat")).toBeUndefined();
    expect(findChatChannelLabel(" ")).toBeUndefined();
  });
});
