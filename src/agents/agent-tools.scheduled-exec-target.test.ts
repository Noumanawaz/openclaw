/**
 * Scheduled restrict-only exec pin enforcement in createOpenClawCodingTools.
 * A cap captured from a host-pinned creator surface must rebuild exec pinned to
 * that target; absence of the pin keeps baseline exec behavior.
 */
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

const shellSpies = vi.hoisted(() => ({
  exec: vi.fn(async () => ({ content: [], details: {} })),
  process: vi.fn(async () => ({ content: [], details: {} })),
}));

vi.mock("./bash-tools.js", () => ({
  createExecTool: () => ({
    name: "exec",
    description: "exec test double",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        host: { type: "string" },
        security: { type: "string" },
        ask: { type: "string" },
        node: { type: "string" },
      },
      required: ["command", "host"],
    },
    execute: shellSpies.exec,
  }),
  createProcessTool: () => ({
    name: "process",
    description: "process test double",
    parameters: { type: "object", properties: {} },
    execute: shellSpies.process,
  }),
}));

describe("createOpenClawCodingTools scheduled exec target", () => {
  it("pins exec to the scheduled cap's restrict-only target", async () => {
    const tools = createOpenClawCodingTools({
      scheduledToolPolicy: {
        version: 1,
        mode: "trusted",
        execTarget: { host: "gateway" },
      },
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    // The pinned schema stops advertising host/security/ask/node entirely.
    const properties = Object.keys(
      (execTool?.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(properties).toContain("command");
    expect(properties).not.toContain("host");
    expect(properties).not.toContain("security");
    expect(properties).not.toContain("ask");
    expect(properties).not.toContain("node");

    await execTool?.execute?.("call-1", {
      command: "echo hi",
      host: "node",
      node: "remote",
      security: "full",
      ask: "off",
    });
    expect(shellSpies.exec).toHaveBeenCalledWith(
      "call-1",
      { command: "echo hi", host: "gateway" },
      undefined,
      undefined,
    );
  });

  it("keeps baseline exec behavior without a scheduled exec target", async () => {
    const tools = createOpenClawCodingTools({
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    await execTool?.execute?.("call-2", { command: "echo hi", host: "node" });
    expect(shellSpies.exec).toHaveBeenCalledWith(
      "call-2",
      { command: "echo hi", host: "node" },
      undefined,
      undefined,
    );
  });
});
