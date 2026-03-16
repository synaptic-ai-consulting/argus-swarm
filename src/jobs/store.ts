import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkPackage } from "../decomposer/types.js";

const STORE_DIR = ".argus";
const JOBS_FILE = "jobs.json";

export type JobStatus = "creating" | "running" | "finished" | "error";

export interface JobRecord {
  jobId: string;
  intentFile?: string;
  intentSummary: string;
  status: JobStatus;
  createdAt: string;
  agentIds: string[];
  workPackages?: Array<{ id: string; role: string; task: string }>;
}

function getPath(): string {
  return join(process.cwd(), STORE_DIR, JOBS_FILE);
}

function ensureDir(): void {
  const dir = join(process.cwd(), STORE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadAll(): JobRecord[] {
  ensureDir();
  const path = getPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function saveAll(jobs: JobRecord[]): void {
  ensureDir();
  writeFileSync(getPath(), JSON.stringify(jobs, null, 2));
}

export function createJob(
  jobId: string,
  intentSummary: string,
  agentIds: string[],
  workPackages: WorkPackage[],
  intentFile?: string,
): JobRecord {
  const jobs = loadAll();
  const record: JobRecord = {
    jobId,
    intentFile,
    intentSummary,
    status: "running",
    createdAt: new Date().toISOString(),
    agentIds,
    workPackages: workPackages.map((wp) => ({
      id: wp.id,
      role: wp.role,
      task: wp.task,
    })),
  };
  jobs.push(record);
  saveAll(jobs);
  return record;
}

export function listJobs(): JobRecord[] {
  return loadAll();
}

export function getJob(jobId: string): JobRecord | undefined {
  return loadAll().find((j) => j.jobId === jobId);
}

export function updateJob(jobId: string, updates: Partial<Pick<JobRecord, "status" | "agentIds">>): boolean {
  const jobs = loadAll();
  const idx = jobs.findIndex((j) => j.jobId === jobId);
  if (idx < 0) return false;
  if (updates.status !== undefined) jobs[idx].status = updates.status;
  if (updates.agentIds !== undefined) jobs[idx].agentIds = updates.agentIds;
  saveAll(jobs);
  return true;
}
