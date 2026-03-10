import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getTrust, setTrust, resetTrustStoreForTesting } from "../src/trust/store.js";

test("trust store: getTrust returns null for unknown agent", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "argus-trust-"));
  resetTrustStoreForTesting();
  process.env.ARGUS_STORE_DIR = testDir;
  try {
    const tau = await getTrust("unknown-agent");
    assert.strictEqual(tau, null);
  } finally {
    delete process.env.ARGUS_STORE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("trust store: setTrust and getTrust round-trip", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "argus-trust-"));
  resetTrustStoreForTesting();
  process.env.ARGUS_STORE_DIR = testDir;
  try {
    await setTrust("agent-1", 0.8);
    const tau = await getTrust("agent-1");
    assert.ok(tau !== null, "tau should not be null");
    assert.ok(tau! >= 0 && tau! <= 1, "tau should be in [0,1]");
  } finally {
    delete process.env.ARGUS_STORE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("trust store: setTrust applies exponential smoothing with outcome quality", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "argus-trust-"));
  resetTrustStoreForTesting();
  process.env.ARGUS_STORE_DIR = testDir;
  try {
    await setTrust("agent-2", 0.5, 1);
    const tau1 = await getTrust("agent-2");
    await setTrust("agent-2", 0.5, 1);
    const tau2 = await getTrust("agent-2");
    assert.ok(tau2! > tau1!);
  } finally {
    delete process.env.ARGUS_STORE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("trust store: trust is clamped to [0, 1]", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "argus-trust-"));
  resetTrustStoreForTesting();
  process.env.ARGUS_STORE_DIR = testDir;
  try {
    await setTrust("agent-3", 2);
    const tau = await getTrust("agent-3");
    assert.ok(tau! <= 1);
  } finally {
    delete process.env.ARGUS_STORE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  }
});
