/**
 * Map GitHub check / workflow run names into coarse buckets for P0.1.
 * Order: security, lint, tests — first match wins (security-focused names before generic "test").
 */
const SECURITY_PATTERNS = [
  /codeql/i,
  /snyk/i,
  /trivy/i,
  /gitleaks/i,
  /semgrep/i,
  /bandit/i,
  /sonar/i,
  /defender/i,
  /security/i,
  /dependabot/i,
  /vulnerability/i,
  /sast/i,
  /socket/i,
];

const LINT_PATTERNS = [
  /ruff/i,
  /eslint/i,
  /pylint/i,
  /flake8/i,
  /mypy/i,
  /prettier/i,
  /biome/i,
  /clippy/i,
  /golint/i,
  /lint/i,
  /style.*check/i,
  /format/i,
  /typecheck/i,
  /oxlint/i,
];

const TESTS_PATTERNS = [
  /\bpytest\b/i,
  /\bjest\b/i,
  /\bmocha\b/i,
  /\bvitest\b/i,
  /\bcypress\b/i,
  /\bplaywright\b/i,
  /e2e/i,
  /\bunit\b/i,
  /\bintegration\b/i,
  /coverage/i,
  /\bbuild\b/i,
  /\bci\b/i,
  /\bverify\b/i,
  /\bgradle\b/i,
  /\bmaven\b/i,
  /npm test/i,
  /go test/i,
  /\btest\s+run/i,
  /\btests?\b/i,
];

export type CheckCategory = "tests" | "lint" | "security" | "other";

function matchesAny(s: string, pats: RegExp[]): boolean {
  return pats.some((p) => p.test(s));
}

export function categorizeCheckRunName(name: string): CheckCategory {
  const s = name.trim();
  if (matchesAny(s, SECURITY_PATTERNS)) return "security";
  if (matchesAny(s, LINT_PATTERNS)) return "lint";
  if (matchesAny(s, TESTS_PATTERNS)) return "tests";
  return "other";
}
