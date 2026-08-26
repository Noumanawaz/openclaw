import { describe, expect, it } from "vitest";
import type { CronStoredJob } from "../types.js";
import { reconcileToolsAllowExecTarget } from "./jobs-tool-policy.js";

function toolJob(toolsAllow: string[] | undefined): CronStoredJob {
  return {
    id: "job-1",
    name: "job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: {
      kind: "script",
      script: "return {}",
      ...(toolsAllow ? { toolsAllow } : {}),
    },
    state: {},
  } as unknown as CronStoredJob;
}

describe("reconcileToolsAllowExecTarget", () => {
  it("stamps the restrict-only pin only for exec-granting caps with the server fact", () => {
    const job = toolJob(["exec", "read"]);
    reconcileToolsAllowExecTarget({
      job,
      explicitlyMutatesToolsAllow: true,
      toolsAllowExecTarget: { version: 1, host: "gateway" },
    });
    expect(job.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway" });
  });

  it("never stamps a pin onto a cap that does not grant exec", () => {
    const job = toolJob(["read"]);
    reconcileToolsAllowExecTarget({
      job,
      explicitlyMutatesToolsAllow: true,
      toolsAllowExecTarget: { version: 1, host: "gateway" },
    });
    expect(job.toolsAllowExecTarget).toBeUndefined();
  });

  it("clears the pin when the cap is explicitly rewritten without the server fact", () => {
    const job = toolJob(["exec"]);
    job.toolsAllowExecTarget = { version: 1, host: "gateway" };
    reconcileToolsAllowExecTarget({ job, explicitlyMutatesToolsAllow: true });
    expect(job.toolsAllowExecTarget).toBeUndefined();
  });

  it("keeps the pin across edits that do not touch the cap", () => {
    const job = toolJob(["exec"]);
    job.toolsAllowExecTarget = { version: 1, host: "gateway" };
    reconcileToolsAllowExecTarget({ job, explicitlyMutatesToolsAllow: false });
    expect(job.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway" });
  });

  it("drops the pin when the job stops using a tool runtime cap", () => {
    const job = toolJob(undefined);
    job.toolsAllowExecTarget = { version: 1, host: "gateway" };
    reconcileToolsAllowExecTarget({
      job,
      explicitlyMutatesToolsAllow: false,
      toolsAllowExecTarget: { version: 1, host: "gateway" },
    });
    expect(job.toolsAllowExecTarget).toBeUndefined();
  });
});
