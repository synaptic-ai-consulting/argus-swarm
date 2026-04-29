import { fetch } from "undici";

const GITHUB_API = "https://api.github.com";

export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const normalized = url.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  const m = normalized.match(/github\.com[/:]([\w-]+\/[\w.-]+)/);
  if (!m) return null;
  const [owner, repo] = m[1].split("/");
  return { owner, repo };
}

export interface CleanupResult {
  branchesDeleted: number;
  branchesFailed: string[];
}

const AGENT_BRANCH_PREFIXES = ["argus/", "cursor/", "codex/"];

function isAgentBranch(name: string): boolean {
  return AGENT_BRANCH_PREFIXES.some((p) => name.startsWith(p));
}

/** Exported for other GitHub REST paginated endpoints (e.g. check runs). */
export function parseLinkHeader(link: string | null): { next?: string } {
  if (!link) return {};
  const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
  return nextMatch ? { next: nextMatch[1] } : {};
}

/**
 * Delete all argus/* and cursor/* branches from the configured repository.
 * Cursor Cloud Agents may create cursor/* branches. Requires token with repo scope.
 * If dryRun, only lists branches.
 */
export async function cleanupArgusBranches(
  repositoryUrl: string,
  token: string | undefined,
  options?: { dryRun?: boolean }
): Promise<CleanupResult> {
  const repo = parseRepoUrl(repositoryUrl);
  if (!repo) {
    throw new Error(`Invalid GitHub repository URL: ${repositoryUrl}`);
  }

  const { owner, repo: repoName } = repo;
  const auth = token ? `Bearer ${token}` : undefined;

  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (auth) headers.Authorization = auth;

  let allBranches: Array<{ name: string }> = [];
  let url: string | undefined = `${GITHUB_API}/repos/${owner}/${repoName}/branches?per_page=100`;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API error: ${res.status} ${body}`);
    }
    const page = (await res.json()) as Array<{ name: string }>;
    allBranches = allBranches.concat(page);
    const link = parseLinkHeader(res.headers.get("link"));
    url = link.next;
  }

  const agentBranches = allBranches.filter((b) => isAgentBranch(b.name));

  const result: CleanupResult = { branchesDeleted: 0, branchesFailed: [] };

  if (agentBranches.length === 0) {
    console.log("No argus/*, cursor/*, or codex/* branches found.");
    return result;
  }

  if (options?.dryRun) {
    console.log(`Would delete ${agentBranches.length} branch(es):`);
    agentBranches.forEach((b) => console.log(`  ${b.name}`));
    return result;
  }

  if (!token) {
    throw new Error("GITHUB_TOKEN required for cleanup (omit --dry-run to delete)");
  }

  for (const branch of agentBranches) {
    const ref = `heads/${branch.name}`;
    const deleteRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repoName}/git/refs/${ref}`,
      {
        method: "DELETE",
        headers: { ...headers, Authorization: auth! },
      }
    );

    if (deleteRes.ok) {
      result.branchesDeleted++;
      console.log(`  Deleted branch: ${branch.name}`);
    } else {
      result.branchesFailed.push(branch.name);
      const body = await deleteRes.text();
      console.error(`  Failed to delete ${branch.name}: ${deleteRes.status} ${body}`);
    }
  }

  return result;
}
