import {
  createTrustedCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type {
  CronStoredJob,
  CronToolsAllowExecTarget,
  CronToolsAllowProvenance,
} from "../types.js";

export function stampScheduledToolPolicy(
  job: CronStoredJob,
  scheduledToolPolicy: CronScheduledToolPolicy | undefined,
): void {
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    return;
  }
  const policy = scheduledToolPolicy ?? createTrustedCronScheduledToolPolicy();
  if (
    policy.mode === "account" &&
    (job.owner?.sessionKey !== policy.ownerSessionKey ||
      job.owner?.accountId !== policy.ownerAccountId)
  ) {
    throw new Error("scheduled account policy must match the persisted job owner");
  }
  job.scheduledToolPolicy = structuredClone(policy);
}

export function reconcileScheduledToolPolicy(params: {
  job: CronStoredJob;
  previouslyUsedToolRuntime: boolean;
  explicitlyMutatesToolsAllow: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy;
}): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.scheduledToolPolicy;
    return;
  }
  const current = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  if (current) {
    job.scheduledToolPolicy = current;
    return;
  }
  delete job.scheduledToolPolicy;
  if (params.explicitlyMutatesToolsAllow || !params.previouslyUsedToolRuntime) {
    stampScheduledToolPolicy(job, params.scheduledToolPolicy);
  }
}

/**
 * Stamps or clears the restrict-only exec pin alongside the cap it was
 * captured with. The pin exists only while the job grants canonical `exec`
 * from a creator surface whose exec capability was host-pinned; explicit cap
 * rewrites without that server-verified fact clear it, falling back to the
 * baseline unpinned exec policy.
 */
export function reconcileToolsAllowExecTarget(params: {
  job: CronStoredJob;
  explicitlyMutatesToolsAllow: boolean;
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
}): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job) || job.payload.toolsAllow === undefined) {
    delete job.toolsAllowExecTarget;
    return;
  }
  if (!params.explicitlyMutatesToolsAllow) {
    return;
  }
  const grantsExec =
    Array.isArray(job.payload.toolsAllow) && job.payload.toolsAllow.includes("exec");
  if (params.toolsAllowExecTarget && grantsExec) {
    job.toolsAllowExecTarget = structuredClone(params.toolsAllowExecTarget);
  } else {
    delete job.toolsAllowExecTarget;
  }
}

export function reconcileToolsAllowProvenance(params: {
  job: CronStoredJob;
  explicitlyMutatesToolsAllow: boolean;
  toolsAllowProvenance?: CronToolsAllowProvenance;
}): void {
  if (!params.explicitlyMutatesToolsAllow) {
    return;
  }
  if (
    params.job.payload.toolsAllowIsDefault === true &&
    params.toolsAllowProvenance?.version === 1 &&
    params.toolsAllowProvenance.source === "final-executable-surface"
  ) {
    params.job.toolsAllowProvenance = structuredClone(params.toolsAllowProvenance);
    return;
  }
  delete params.job.toolsAllowProvenance;
}
