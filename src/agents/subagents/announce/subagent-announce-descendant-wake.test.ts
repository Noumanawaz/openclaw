import { describe, expect, it, vi } from "vitest";

const terminateAcceptedCollectorRun = vi.hoisted(() => vi.fn());

vi.mock("../spawn/subagent-spawn-cleanup.js", () => ({
  terminateAcceptedCollectorRun,
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  loadSessionEntryByKey: () => ({
    sessionId: "child-session-id",
    lifecycleRevision: "child-lifecycle",
  }),
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
}));

import { runDescendantWake } from "./subagent-announce-descendant-wake.js";

describe("runDescendantWake", () => {
  it("propagates the owning gateway resolver through dispatch and successor replacement", async () => {
    const resolveGatewayContext = () => ({ owner: "gateway-a" }) as never;
    const dispatchGatewayMethodInProcessMock = vi.fn(async () => ({ runId: "wake-run" }));
    const dispatchGatewayMethodInProcess =
      dispatchGatewayMethodInProcessMock as unknown as typeof import("./subagent-announce.runtime.js").dispatchGatewayMethodInProcess;
    const replaceSubagentRunAfterSteer = vi.fn(async () => true);

    await expect(
      runDescendantWake({
        runId: "parent-run",
        childSessionKey: "agent:main:subagent:parent",
        taskLabel: "parent task",
        findings: "child findings",
        announceId: "announce-parent",
        isChildSessionEffectsAllowed: () => true,
        hasUsableSessionEntry: (entry): entry is Record<string, unknown> => Boolean(entry),
        deps: {
          callGateway: vi.fn(),
          dispatchGatewayMethodInProcess,
          getRuntimeConfig: () => ({}),
          replaceSubagentRunAfterSteer,
        },
        resolveGatewayContext,
      }),
    ).resolves.toBe(true);

    expect(dispatchGatewayMethodInProcessMock).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({ resolveGatewayContext }),
    );
    expect(replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayContextResolver: resolveGatewayContext }),
    );
    expect(terminateAcceptedCollectorRun).not.toHaveBeenCalled();
  });
});
