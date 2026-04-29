import { fetch } from "undici";
import { parseLinkHeader } from "../../cleanup/github.js";
import { categorizeCheckRunName, type CheckCategory } from "./categorize.js";

const GITHUB_API = "https://api.github.com";

export function parseGitHubPrUrl(
  prUrl: string
): { owner: string; repo: string; pr: number } | null {
  const m = prUrl
    .replace(/#.*$/, "")
    .match(/github\.com\/([^/]+)\/([^/]+?)\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, pr: parseInt(m[3]!, 10) };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };
}

export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

/**
 * List check runs for a commit (paginated).
 */
export async function fetchCheckRunsForCommit(
  owner: string,
  repo: string,
  headSha: string,
  token: string
): Promise<GitHubCheckRun[]> {
  const out: GitHubCheckRun[] = [];
  let url: string | undefined =
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`;

  while (url) {
    const res = await fetch(url, { headers: githubHeaders(token) });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub check-runs: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { check_runs: GitHubCheckRun[] };
    out.push(...(data.check_runs ?? []));
    const link = parseLinkHeader(res.headers.get("link"));
    url = link.next;
  }

  return out;
}

export async function fetchPullRequestHeadSha(
  owner: string,
  repo: string,
  pr: number,
  token: string
): Promise<string> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pr}`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub pull: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { head: { sha: string } };
  if (!data.head?.sha) {
    throw new Error("GitHub pull response missing head.sha");
  }
  return data.head.sha;
}

/**
 * A completed check run is "green" for our purposes.
 */
function isConclusionSuccess(conclusion: string | null, status: string): boolean {
  if (status !== "completed") return false;
  if (conclusion == null) return false;
  return (
    conclusion === "success" || conclusion === "neutral" || conclusion === "skipped"
  );
}

export interface CategorizedCheckAggregate {
  category: CheckCategory;
  runNames: string[];
  allPassed: boolean;
  hadRuns: boolean;
  detail: string;
}

/**
 * Group raw check-runs by category; compute pass/fail per category.
 */
export function aggregateCheckRuns(
  runs: GitHubCheckRun[]
): { categories: Map<CheckCategory, CategorizedCheckAggregate> } {
  const byCat = new Map<CheckCategory, GitHubCheckRun[]>();
  for (const c of ["tests", "lint", "security", "other"] as CheckCategory[]) {
    byCat.set(c, []);
  }

  for (const run of runs) {
    const cat = categorizeCheckRunName(run.name);
    byCat.get(cat)!.push(run);
  }

  const categories = new Map<CheckCategory, CategorizedCheckAggregate>();

  for (const cat of ["tests", "lint", "security", "other"] as CheckCategory[]) {
    const list = byCat.get(cat) ?? [];
    if (list.length === 0) {
      categories.set(cat, {
        category: cat,
        runNames: [],
        allPassed: true,
        hadRuns: false,
        detail: "no check runs in this category",
      });
      continue;
    }
    const allPassed = list.every((r) => isConclusionSuccess(r.conclusion, r.status));
    const names = list.map((r) => r.name);
    const failed = list
      .filter((r) => !isConclusionSuccess(r.conclusion, r.status))
      .map((r) => `${r.name}(${r.status}/${r.conclusion})`);
    categories.set(cat, {
      category: cat,
      runNames: names,
      allPassed,
      hadRuns: true,
      detail: allPassed
        ? `all green (${list.length} run(s))`
        : `failing: ${failed.join(", ")}`,
    });
  }

  return { categories };
}
