import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { applyLoggingConfig, resetLogger } from "../../logging/logger.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import type { ToolDefinition } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("AgentSession canonical tool-result persistence", () => {
  it.each(
    ["memory", "sqlite"].flatMap((storage) => [
      { storage, label: "unchanged", ids: ["call_fixture_plain"], redactPatterns: undefined },
      {
        storage,
        label: "redacted",
        ids: [`call_fixture|fc-${"a".repeat(24)}`],
        redactPatterns: undefined,
      },
      {
        storage,
        label: "mixed",
        ids: ["call_fixture_plain", `call_fixture|fc-${"b".repeat(24)}`],
        redactPatterns: undefined,
      },
      {
        storage,
        label: "custom redaction",
        ids: ["call_fixture|fc-3sZ_abcdefghijklGXuo"],
        redactPatterns: ["fc-[A-Za-z0-9_-]+"],
      },
    ]),
  )(
    "pairs successful $storage $label tool calls after persistence redaction",
    async ({ storage, ids, redactPatterns }) => {
      const executedIds: string[] = [];
      const tool: ToolDefinition = {
        name: "inspect",
        label: "Inspect",
        description: "Returns a fixture observation",
        parameters: Type.Object({}),
        execute: async (id) => {
          executedIds.push(id);
          return { content: [{ type: "text", text: "observed" }], details: {} };
        },
      };
      let requests = 0;
      streamMocks.streamSimple.mockImplementation((model: Model) =>
        createAssistantResultStream(
          ++requests === 1
            ? createAssistant(
                model,
                ids.map((id) => ({ type: "toolCall", id, name: tool.name, arguments: {} })),
                "toolUse",
              )
            : createAssistant(model, [{ type: "text", text: "complete" }]),
        ),
      );
      const dir = tempDirs.make("openclaw-canonical-tool-pair-");
      const target =
        storage === "sqlite"
          ? {
              agentId: "main",
              sessionId: "canonical-tool-pair",
              sessionKey: "agent:main:canonical-tool-pair",
              storePath: path.join(dir, "sessions.json"),
            }
          : undefined;
      if (target) {
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      }
      applyLoggingConfig({ redactPatterns });
      try {
        const manager = guardSessionManager(
          target ? SessionManager.open(target, dir) : SessionManager.inMemory(),
          {
            config: { logging: { redactPatterns } },
            missingToolResultText: "aborted",
          },
        );
        const { session } = await createTestSession({
          sessionManager: manager,
          customTools: [tool],
        });

        await session.prompt("Inspect the fixture");
        manager.flushPendingToolResults?.();

        const messages = manager
          .getEntries()
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
        const persistedIds = messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
            : [],
        );
        expect(requests).toBe(2);
        expect(executedIds).toEqual(persistedIds);
        expect(executedIds).toHaveLength(ids.length);
        expect(executedIds).toEqual(
          ids.map((id) => (id.includes("|") ? expect.not.stringContaining(id) : id)),
        );
        expect(messages.filter((message) => message.role === "toolResult")).toEqual(
          executedIds.map((toolCallId) =>
            expect.objectContaining({
              toolCallId,
              toolName: tool.name,
              isError: false,
              content: [{ type: "text", text: "observed" }],
            }),
          ),
        );
        expect(session.getLastAssistantText()).toBe("complete");
        if (target) {
          const stored = await loadTranscriptEvents(target);
          for (const entry of manager.getEntries()) {
            if (entry.type === "message") {
              expect(stored).toContainEqual(entry);
            }
          }
        }
      } finally {
        resetLogger();
        if (target) {
          closeOpenClawAgentDatabaseByPath(
            resolveSqliteTargetFromSessionStorePath(target.storePath).path,
          );
        }
      }
    },
  );
});
