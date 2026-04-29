import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";

const STORE_DIR = ".argus";
const DB_FILE = "trust.db";

let db: Database | null = null;

function getDbPath(): string {
  const base = process.env.ARGUS_STORE_DIR ?? process.cwd();
  return join(base, STORE_DIR, DB_FILE);
}

async function getDb(): Promise<Database> {
  if (db) return db;

  const base = process.env.ARGUS_STORE_DIR ?? process.cwd();
  const dir = join(base, STORE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();
  const path = getDbPath();

  if (existsSync(path)) {
    const buf = readFileSync(path);
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_trust (
      agent_id TEXT PRIMARY KEY,
      tau REAL NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  return db;
}

export async function getTrust(agentId: string): Promise<number | null> {
  const d = await getDb();
  const stmt = d.prepare("SELECT tau FROM agent_trust WHERE agent_id = ?");
  stmt.bind([agentId]);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const tau = stmt.get()[0] as number;
  stmt.free();
  return tau;
}

export async function setTrust(
  agentId: string,
  tau: number,
  outcomeQuality?: number
): Promise<void> {
  const d = await getDb();
  const alpha = 0.7;
  const existing = await getTrust(agentId);
  const prevTau = existing ?? 0.5;
  const r = outcomeQuality ?? tau;
  const newTau = alpha * prevTau + (1 - alpha) * r;
  const clamped = Math.max(0, Math.min(1, newTau));

  d.run(
    "INSERT OR REPLACE INTO agent_trust (agent_id, tau, updated_at) VALUES (?, ?, ?)",
    [agentId, clamped, new Date().toISOString()]
  );
  saveDb();
}

function saveDb(): void {
  if (!db) return;
  writeFileSync(getDbPath(), Buffer.from(db.export()));
}

export interface TrustEntry {
  agentId: string;
  tau: number;
  updatedAt: string;
}

export async function getAllTrust(): Promise<TrustEntry[]> {
  const d = await getDb();
  const stmt = d.prepare("SELECT agent_id, tau, updated_at FROM agent_trust");
  const results: TrustEntry[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    results.push({
      agentId: row[0] as string,
      tau: row[1] as number,
      updatedAt: row[2] as string,
    });
  }
  stmt.free();
  return results;
}

export async function deleteTrustForAgents(agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  const d = await getDb();
  for (const id of agentIds) {
    d.run("DELETE FROM agent_trust WHERE agent_id = ?", [id]);
  }
  saveDb();
}

/** Reset in-memory db cache. Used by tests when switching store dirs. */
export function resetTrustStoreForTesting(): void {
  db = null;
}
