import { test } from "node:test";
import assert from "node:assert";
import { decompose } from "../src/decomposer/index.js";
import type { Intent } from "../src/intent/schema.js";

test("decomposer: decomposes OAuth intent into 5 work packages", () => {
    const intent: Intent = {
      intent: "Implement OAuth2 authentication supporting Google and GitHub",
      constraints: ["Use existing auth library", "No DB schema changes"],
    };
    const packages = decompose(intent);
    assert.strictEqual(packages.length, 5);
    assert.strictEqual(packages[0].role, "Explorer");
    assert.strictEqual(packages[1].role, "Worker");
    assert.strictEqual(packages[4].role, "Validator");
    assert.ok(packages[0].task.toLowerCase().includes("oauth"));
    assert.ok(packages.every((p) => p.constraints.length === 2));
});

test("decomposer: decomposes generic intent when no heuristic matches", () => {
    const intent: Intent = {
      intent: "Refactor the logging module",
      constraints: [],
    };
    const packages = decompose(intent);
    assert.ok(packages.length >= 1);
    assert.strictEqual(packages[0].task, "Refactor the logging module");
});

test("decomposer: respects maxPackages limit", () => {
    const intent: Intent = {
      intent: "Implement OAuth2 authentication",
      constraints: [],
    };
    const packages = decompose(intent, 3);
    assert.strictEqual(packages.length, 3);
});

test("decomposer: each package has unique id", () => {
    const intent: Intent = { intent: "OAuth2 auth", constraints: [] };
    const packages = decompose(intent);
    const ids = packages.map((p) => p.id);
    assert.strictEqual(new Set(ids).size, ids.length);
});
