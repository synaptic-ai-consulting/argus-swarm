import { test } from "node:test";
import assert from "node:assert";
import { computeValidationResult } from "../src/validator/index.js";
import { METADATA_ONLY_CONFIDENCE_CAP } from "../src/validator/score.js";

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

test("validator: human_review when summary missing (confidence below θ)", () => {
    const agent = {
      id: "agent-2",
      status: "FINISHED" as const,
      summary: "",
      target: { prUrl: "https://github.com/org/repo/pull/2" },
    };
    const result = computeValidationResult(agent);
    assert.strictEqual(result.decision, "human_review");
    assert.ok(result.confidence < 0.85);
});

test("validator: human_review when status is ERROR", () => {
    const agent = {
      id: "agent-3",
      status: "ERROR" as const,
      summary: "Failed",
      target: {},
    };
    const result = computeValidationResult(agent);
    assert.strictEqual(result.decision, "human_review");
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

test("validator: custom reviewThreshold θ", () => {
    const agent = {
      id: "agent-5",
      status: "FINISHED" as const,
      summary: "Done",
      target: { prUrl: "https://github.com/org/repo/pull/5" },
    };
    const result = computeValidationResult(agent, {
      reviewThreshold: 0.99,
    });
    assert.strictEqual(result.decision, "auto_approve");
    assert.strictEqual(result.confidence, 1);
});

test("validator: metadata fallback cap when CI unavailable", () => {
  const agent = {
    id: "agent-cap",
    status: "FINISHED" as const,
    summary: "Done",
    target: { prUrl: "https://github.com/org/repo/pull/9" },
  };
  const result = computeValidationResult(agent, {
    useConfidenceCap: true,
    extraChecks: [
      { name: "github_checks", passed: false, output: "0 check runs" },
    ],
    validationMode: "metadata_fallback",
  });
  assert.ok(result.confidence <= METADATA_ONLY_CONFIDENCE_CAP);
  assert.strictEqual(result.decision, "human_review");
  assert.strictEqual(result.validationMode, "metadata_fallback");
});

test("validator: stricter θ (0.9) yields human_review where default would auto_approve", () => {
  const agent = {
    id: "agent-thr",
    status: "FINISHED" as const,
    summary: "Done",
    target: { prUrl: "https://github.com/org/repo/pull/7" },
  };
  const extra = [
    { name: "ci_a", passed: true, output: "" },
    { name: "ci_b", passed: true, output: "" },
    { name: "ci_c", passed: true, output: "" },
    { name: "ci_d", passed: true, output: "" },
    { name: "ci_e", passed: false, output: "simulated" },
  ];
  const withStrict = computeValidationResult(agent, { reviewThreshold: 0.9, extraChecks: extra });
  const withDefault = computeValidationResult(agent, { extraChecks: extra });
  assert.ok(withStrict.confidence < 0.9 && withStrict.confidence >= 0.8);
  assert.strictEqual(withStrict.decision, "human_review");
  assert.strictEqual(withDefault.decision, "auto_approve");
});

test("validator: security_passed failure prevents auto_approve", () => {
  const agent = {
    id: "agent-sec",
    status: "FINISHED" as const,
    summary: "Done",
    target: { prUrl: "https://github.com/org/repo/pull/10" },
  };
  const result = computeValidationResult(agent, {
    extraChecks: [
      { name: "github_checks", passed: true, output: "ok" },
      { name: "tests_passed", passed: true, output: "ok" },
      { name: "lint_passed", passed: true, output: "ok" },
      { name: "security_passed", passed: false, output: "CodeQL failed" },
      { name: "other_ci", passed: true, output: "ok" },
    ],
    validationMode: "github_checks",
  });
  assert.strictEqual(result.decision, "human_review");
  assert.ok(result.checks.find((c) => c.name === "security_passed")?.passed === false);
});
