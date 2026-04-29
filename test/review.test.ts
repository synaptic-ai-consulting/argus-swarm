import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addException,
  listExceptions,
  getException,
  resolveException,
} from "../src/review/store.js";

function withTestDir(fn: (dir: string) => void | Promise<void>) {
  const testDir = mkdtempSync(join(tmpdir(), "argus-review-"));
  process.env.ARGUS_STORE_DIR = testDir;
  try {
    return fn(testDir);
  } finally {
    delete process.env.ARGUS_STORE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  }
}

test("review store: addException creates exception with id", () => {
  withTestDir(() => {
    const result = {
      agentId: "agent-1",
      confidence: 0.5,
      checks: [{ name: "test", passed: false }],
      decision: "human_review" as const,
    };
    const ex = addException(result);
    assert.ok(ex.id.startsWith("ex-"));
    assert.strictEqual(ex.agentId, "agent-1");
    assert.strictEqual(ex.confidence, 0.5);
  });
});

test("review store: addException marks synthetic for demo exceptions", () => {
  withTestDir(() => {
    const r = { agentId: "a", confidence: 0.5, checks: [], decision: "human_review" as const };
    const ex = addException(r, { synthetic: true });
    assert.strictEqual(ex.synthetic, true);
  });
});

test("review store: listExceptions returns all when pendingOnly false", () => {
  withTestDir(() => {
    addException({
      agentId: "a1",
      confidence: 0.5,
      checks: [],
      decision: "human_review",
    });
    addException({
      agentId: "a2",
      confidence: 0.5,
      checks: [],
      decision: "human_review",
    });
    const all = listExceptions(false);
    assert.strictEqual(all.length, 2);
  });
});

test("review store: listExceptions filters resolved when pendingOnly true", () => {
  withTestDir(() => {
    const ex1 = addException({
      agentId: "a1",
      confidence: 0.5,
      checks: [],
      decision: "human_review",
    });
    addException({
      agentId: "a2",
      confidence: 0.5,
      checks: [],
      decision: "human_review",
    });
    resolveException(ex1.id, "approved");
    const pending = listExceptions(true);
    assert.strictEqual(pending.length, 1);
  });
});

test("review store: resolveException returns false for unknown id", () => {
  withTestDir(() => {
    const ok = resolveException("ex-unknown", "approved");
    assert.strictEqual(ok, false);
  });
});

test("review store: getException returns undefined for unknown id", () => {
  withTestDir(() => {
    const ex = getException("ex-unknown");
    assert.strictEqual(ex, undefined);
  });
});
