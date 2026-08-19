import { describe, expect, it } from "vitest";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getSharedGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";

describe("subagent Gateway context binding", () => {
  it("keeps successor routing private and excludes restored rows", () => {
    const context = { owner: "gateway-a" } as never;
    const resolver = () => context;
    const source = createSubagentRunRecord({ runId: "run-source" });
    const successor = createSubagentRunRecord({ runId: "run-successor" });
    const restored = structuredClone(source);

    bindGatewayContextResolver(source, resolver);
    bindGatewayContextResolver(successor, getGatewayContextResolver(source));

    expect(getGatewayContextResolver(successor)?.()).toBe(context);
    expect(getGatewayContextResolver(restored)).toBeUndefined();
  });

  it("refuses to select one Gateway for a mixed-owner settle batch", () => {
    const first = createSubagentRunRecord({ runId: "run-first" });
    const second = createSubagentRunRecord({ runId: "run-second" });
    const firstContext = { owner: "gateway-a" } as never;
    const secondContext = { owner: "gateway-b" } as never;
    bindGatewayContextResolver(first, () => firstContext);
    bindGatewayContextResolver(second, () => secondContext);

    expect(getGatewayContextResolver(first)?.()).toBe(firstContext);
    expect(getGatewayContextResolver(second)?.()).toBe(secondContext);
    const shared = getSharedGatewayContextResolver([first, second]);
    expect(shared).toBeTypeOf("function");
    expect(shared?.()).toBeUndefined();
  });

  it("rejects separate sibling resolver identities even when they resolve the same context", () => {
    const first = createSubagentRunRecord({ runId: "run-first" });
    const second = createSubagentRunRecord({ runId: "run-second" });
    const context = { owner: "gateway-a" } as never;
    bindGatewayContextResolver(first, () => context);
    bindGatewayContextResolver(second, () => context);

    const shared = getSharedGatewayContextResolver([first, second]);
    expect(shared).toBeTypeOf("function");
    expect(shared?.()).toBeUndefined();
  });

  it("refuses a mixed bound and unbound settle batch", () => {
    const bound = createSubagentRunRecord({ runId: "run-bound" });
    const unbound = createSubagentRunRecord({ runId: "run-unbound" });
    bindGatewayContextResolver(bound, () => ({ owner: "gateway-a" }) as never);

    const shared = getSharedGatewayContextResolver([unbound, bound]);
    expect(shared).toBeTypeOf("function");
    expect(shared?.()).toBeUndefined();
  });
});
