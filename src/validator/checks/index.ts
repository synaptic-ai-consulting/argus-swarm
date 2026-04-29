import type { Agent } from "../../api/types.js";
import { parseGitHubPrUrl, fetchPullRequestHeadSha, fetchCheckRunsForCommit, aggregateCheckRuns } from "./github.js";
import type { CheckResult } from "../types.js";

const FALLBACK_MSG = (reason: string) =>
  `CI unavailable; metadata-only path with confidence cap: ${reason}`;

export type GithubValidationMode = "github_checks" | "metadata_fallback";

export interface GithubValidationOutcome {
  mode: GithubValidationMode;
  checks: CheckResult[];
  /** When mode is metadata_fallback, scoring caps confidence. */
  useConfidenceCap: boolean;
  fallbackReason?: string;
}

/**
 * When token + PR URL are present, load GitHub check-runs for the PR head and build checks.
 * When anything is missing or the API returns no runs, return fallback mode with cap.
 */
export async function runGithubValidationChecks(
  prUrl: string | undefined,
  token: string | undefined
): Promise<GithubValidationOutcome> {
  if (!token?.trim()) {
    return {
      mode: "metadata_fallback",
      useConfidenceCap: true,
      fallbackReason: "GITHUB_TOKEN not set",
      checks: [
        { name: "github_checks", passed: false, output: FALLBACK_MSG("GITHUB_TOKEN not set") },
      ],
    };
  }

  if (!prUrl?.trim()) {
    return {
      mode: "metadata_fallback",
      useConfidenceCap: true,
      fallbackReason: "agent has no pull request URL",
      checks: [
        {
          name: "github_checks",
          passed: false,
          output: FALLBACK_MSG("no PR URL on agent target"),
        },
      ],
    };
  }

  const parsed = parseGitHubPrUrl(prUrl);
  if (!parsed) {
    return {
      mode: "metadata_fallback",
      useConfidenceCap: true,
      fallbackReason: "PR URL is not a GitHub pull request link",
      checks: [
        {
          name: "github_checks",
          passed: false,
          output: FALLBACK_MSG("unparseable PR URL"),
        },
      ],
    };
  }

  const { owner, repo, pr } = parsed;
  let headSha: string;
  try {
    headSha = await fetchPullRequestHeadSha(owner, repo, pr, token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      mode: "metadata_fallback",
      useConfidenceCap: true,
      fallbackReason: `failed to read PR head: ${msg}`,
      checks: [
        { name: "github_checks", passed: false, output: FALLBACK_MSG(`pull API: ${msg}`) },
      ],
    };
  }

  let runs: Awaited<ReturnType<typeof fetchCheckRunsForCommit>>;
  try {
    runs = await fetchCheckRunsForCommit(owner, repo, headSha, token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      mode: "metadata_fallback",
      useConfidenceCap: true,
      fallbackReason: `check-runs API failed: ${msg}`,
      checks: [
        { name: "github_checks", passed: false, output: FALLBACK_MSG(`check-runs: ${msg}`) },
      ],
    };
  }

  if (runs.length === 0) {
    return {
      mode: "metadata_fallback",
      useConfidenceCap: true,
      fallbackReason: "no check runs on PR head (CI may be absent or not reporting Checks)",
      checks: [
        {
          name: "github_checks",
          passed: false,
          output: FALLBACK_MSG("0 check runs on head commit"),
        },
      ],
    };
  }

  const { categories } = aggregateCheckRuns(runs);
  const checks: CheckResult[] = [
    {
      name: "github_checks",
      passed: true,
      output: `head=${headSha.slice(0, 7)}…; ${runs.length} check run(s)`,
    },
  ];

  for (const name of ["tests", "lint", "security", "other"] as const) {
    const agg = categories.get(name)!;
    const checkName = name === "other" ? "other_ci" : `${name}_passed`;
    if (name === "other") {
      checks.push({
        name: checkName,
        passed: agg.allPassed,
        output: agg.hadRuns ? agg.detail : "no unmapped check runs",
      });
    } else {
      checks.push({
        name: checkName,
        passed: !agg.hadRuns || agg.allPassed,
        output: agg.hadRuns
          ? `${name}: ${agg.detail}`
          : `${name}: no runs matched (N/A)`,
      });
    }
  }

  return {
    mode: "github_checks",
    useConfidenceCap: false,
    checks,
  };
}

/**
 * For tests: supply PR URL and optional token; uses agent target like validate().
 */
export function collectPrUrl(agent: Pick<Agent, "target">): string | undefined {
  return agent.target?.prUrl;
}
