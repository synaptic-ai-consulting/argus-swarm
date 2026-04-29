/**
 * Integration test with mocked Cursor API.
 * Uses undici MockAgent to intercept fetch without real network calls.
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockAgent, setGlobalDispatcher } from "undici";

const mockAgentData = {
  id: "bc_mock123",
  name: "Test",
  status: "FINISHED",
  source: { repository: "https://github.com/test/repo", ref: "main" },
  target: {
    branchName: "argus/agent-abc-hello",
    prUrl: "https://github.com/test/repo/pull/1",
  },
  summary: "Added hello world endpoint",
  createdAt: new Date().toISOString(),
};

test("integration: full run flow with mocked API", async () => {
  const mockAgent = new MockAgent();
  setGlobalDispatcher(mockAgent);
  mockAgent.disableNetConnect();

  const pool = mockAgent.get("https://api.cursor.com");
  pool
    .intercept({ path: "/v0/agents", method: "GET" })
    .reply(200, { agents: [mockAgentData], nextCursor: undefined });
  pool
    .intercept({ path: /^\/v0\/agents\/bc_mock123$/, method: "GET" })
    .reply(200, mockAgentData);

  const headSha = "abc1234";
  const gh = mockAgent.get("https://api.github.com");
  gh.intercept({ path: "/repos/test/repo/pulls/1", method: "GET" }).reply(200, {
    head: { sha: headSha },
  });
  gh
    .intercept({
      path: new RegExp(`^/repos/test/repo/commits/${headSha}/check-runs`),
      method: "GET",
    })
    .reply(200, {
      check_runs: [
        { name: "Unit tests", status: "completed", conclusion: "success" },
      ],
    });

  const testDir = mkdtempSync(join(tmpdir(), "argus-integration-"));
  process.env.ARGUS_STORE_DIR = testDir;

  writeFileSync(
    join(testDir, "test.intent.yaml"),
    `
intent: "Add a hello world endpoint"
constraints:
  - Use existing framework
reviewThreshold: 0.85
`
  );

  const oldCwd = process.cwd();
  process.chdir(testDir);

  try {
    const { loadIntent } = await import("../src/intent/loader.js");
    const { decompose } = await import("../src/decomposer/index.js");
    const { listAgents } = await import("../src/api/client.js");
    const { validate } = await import("../src/validator/index.js");
    const { addException, listExceptions } = await import("../src/review/store.js");

    const intent = loadIntent("test.intent.yaml");
    const packages = decompose(intent, 2);
    assert.strictEqual(packages.length, 2);

    const { agents } = await listAgents("fake-api-key");
    assert.ok(agents.length >= 0);

    const result = await validate({
      apiKey: "fake-api-key",
      agentId: "bc_mock123",
      githubToken: "fake-gh-token",
      intent: intent.intent,
      constraints: intent.constraints,
    });
    assert.strictEqual(result.agentId, "bc_mock123");
    assert.strictEqual(result.decision, "auto_approve");

    addException({
      ...result,
      decision: "human_review",
      confidence: 0.5,
    });
    const exceptions = listExceptions(true);
    assert.strictEqual(exceptions.length, 1);
  } finally {
    mockAgent.close();
    process.chdir(oldCwd);
    delete process.env.ARGUS_STORE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  }
});
