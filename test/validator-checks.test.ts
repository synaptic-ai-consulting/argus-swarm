import { test } from "node:test";
import assert from "node:assert";
import { categorizeCheckRunName } from "../src/validator/checks/categorize.js";
import {
  parseGitHubPrUrl,
  aggregateCheckRuns,
} from "../src/validator/checks/github.js";

test("categorize: codeql is security", () => {
  assert.strictEqual(categorizeCheckRunName("CodeQL"), "security");
});

test("categorize: ruff is lint", () => {
  assert.strictEqual(categorizeCheckRunName("Ruff check"), "lint");
});

test("categorize: unit tests is tests", () => {
  assert.strictEqual(categorizeCheckRunName("Unit tests"), "tests");
});

test("parseGitHubPrUrl: extracts owner repo and pr", () => {
  const p = parseGitHubPrUrl("https://github.com/acme/Widget/pull/42/files");
  assert.deepStrictEqual(p, { owner: "acme", repo: "Widget", pr: 42 });
});

test("aggregateCheckRuns: all success", () => {
  const { categories } = aggregateCheckRuns([
    { name: "mypy", status: "completed", conclusion: "success" },
    { name: "Unit tests", status: "completed", conclusion: "success" },
  ]);
  assert.strictEqual(categories.get("lint")?.allPassed, true);
  assert.strictEqual(categories.get("lint")?.hadRuns, true);
  assert.strictEqual(categories.get("tests")?.allPassed, true);
});

test("aggregateCheckRuns: failure in one category", () => {
  const { categories } = aggregateCheckRuns([
    { name: "Ruff", status: "completed", conclusion: "failure" },
  ]);
  assert.strictEqual(categories.get("lint")?.allPassed, false);
});
