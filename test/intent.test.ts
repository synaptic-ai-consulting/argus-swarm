import { test } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadIntent } from "../src/intent/loader.js";
import { IntentSchema, resolveReviewThreshold } from "../src/intent/schema.js";

test("intent schema: parses valid intent", () => {
    const raw = {
      intent: "Add feature X",
      constraints: ["Constraint 1"],
      trustThresholds: { autoApprove: 0.9, escalate: 0.5, block: 0.3 },
    };
    const intent = IntentSchema.parse(raw);
    assert.strictEqual(intent.intent, "Add feature X");
    assert.deepStrictEqual(intent.constraints, ["Constraint 1"]);
    assert.strictEqual(intent.trustThresholds?.autoApprove, 0.9);
    assert.strictEqual(resolveReviewThreshold(intent), 0.9);
});

test("intent schema: applies default θ when optional fields missing", () => {
    const intent = IntentSchema.parse({ intent: "Do something" });
    assert.deepStrictEqual(intent.constraints, []);
    assert.strictEqual(resolveReviewThreshold(intent), 0.85);
});

test("intent schema: rejects empty intent", () => {
    assert.throws(() => IntentSchema.parse({ intent: "" }));
});

test("intent loader: loads intent from YAML file", () => {
    const dir = join(tmpdir(), `argus-intent-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "test.intent.yaml");
    writeFileSync(
      path,
      `
intent: "Test intent"
constraints:
  - C1
  - C2
reviewThreshold: 0.8
`
    );

    const oldCwd = process.cwd();
    process.chdir(dir);
    try {
      const intent = loadIntent("test.intent.yaml");
      assert.strictEqual(intent.intent, "Test intent");
      assert.deepStrictEqual(intent.constraints, ["C1", "C2"]);
      assert.strictEqual(resolveReviewThreshold(intent), 0.8);
    } finally {
      process.chdir(oldCwd);
    }
});
