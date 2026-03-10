import { test } from "node:test";
import assert from "node:assert";
import { computeValidationResult } from "../src/validator/index.js";

test("validator: auto_approve when all checks pass", () => {
    const agent = {
      id: "agent-1",
      status: "FINISHED" as const,
      summary: "Done the work",
      target: { prUrl: "https://github.com/org/repo/pull/1", branchName: "feature/x" },
    };
    const result = computeValidationResult(agent);
    assert.strictEqual(result.decision, "auto_approve");
    assert.strictEqual(result.confidence, 1);
});

test("validator: escalate when 2/3 checks pass", () => {
    const agent = {
      id: "agent-2",
      status: "FINISHED" as const,
      summary: "",
      target: { prUrl: "https://github.com/org/repo/pull/2" },
    };
    const result = computeValidationResult(agent);
    assert.strictEqual(result.decision, "escalate");
    assert.ok(result.confidence >= 0.6);
    assert.ok(result.confidence < 0.85);
});

test("validator: block when status is ERROR", () => {
    const agent = {
      id: "agent-3",
      status: "ERROR" as const,
      summary: "Failed",
      target: {},
    };
    const result = computeValidationResult(agent);
    assert.strictEqual(result.decision, "block");
    assert.ok(result.confidence < 0.6);
});

test("validator: incorporates LLM score when provided", () => {
    const agent = {
      id: "agent-4",
      status: "FINISHED" as const,
      summary: "Done",
      target: { prUrl: "https://github.com/org/repo/pull/4" },
    };
    const result = computeValidationResult(agent, { llmScore: 0.5 });
    assert.ok(result.checks.some((c) => c.name === "llm_assessment"));
    assert.ok(result.confidence < 1);
});

test("validator: custom thresholds", () => {
    const agent = {
      id: "agent-5",
      status: "FINISHED" as const,
      summary: "Done",
      target: { prUrl: "https://github.com/org/repo/pull/5" },
    };
    const result = computeValidationResult(agent, {
      thresholds: { autoApprove: 0.99, escalate: 0.5, block: 0.2 },
    });
    assert.ok(["auto_approve", "escalate"].includes(result.decision));
    assert.strictEqual(result.confidence, 1);
});
