/**
 * scm-github plugin — GitHub PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type AutomatedComment,
  type MergeReadiness,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

/** Known bot logins that produce automated review comments */
const BOT_AUTHORS = new Set([
  "cursor[bot]",
  "github-actions[bot]",
  "greptile-apps",
  "codecov[bot]",
  "sonarcloud[bot]",
  "dependabot[bot]",
  "renovate[bot]",
  "codeclimate[bot]",
  "deepsource-autofix[bot]",
  "snyk-bot",
  "lgtm-com[bot]",
]);

function normalizeAuthorLogin(login: string | null | undefined): string {
  return (login ?? "").trim().toLowerCase().replace(/\[bot\]$/, "");
}

function isKnownBotAuthor(login: string | null | undefined): boolean {
  const normalized = normalizeAuthorLogin(login);
  if (!normalized) return false;

  for (const author of BOT_AUTHORS) {
    if (normalizeAuthorLogin(author) === normalized) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

async function getLiveBranch(workspacePath: string | null): Promise<string | null> {
  if (!workspacePath) return null;
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: workspacePath,
      timeout: 30_000,
    });
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

type StatusCheckRollupItem =
  | {
      __typename: "CheckRun";
      name?: string;
      status?: string;
      conclusion?: string;
      detailsUrl?: string;
      startedAt?: string;
      completedAt?: string;
    }
  | {
      __typename: "StatusContext";
      context?: string;
      state?: string;
      targetUrl?: string;
      startedAt?: string;
    };

function mapCheckRunStatus(status: string | undefined, conclusion: string | undefined): CICheck["status"] {
  const normalizedStatus = status?.toUpperCase();
  const normalizedConclusion = conclusion?.toUpperCase();

  if (
    normalizedStatus === "QUEUED" ||
    normalizedStatus === "PENDING" ||
    normalizedStatus === "REQUESTED" ||
    normalizedStatus === "WAITING"
  ) {
    return "pending";
  }
  if (normalizedStatus === "IN_PROGRESS") return "running";

  if (normalizedConclusion === "SUCCESS") return "passed";
  if (normalizedConclusion === "SKIPPED" || normalizedConclusion === "NEUTRAL") return "skipped";
  if (
    normalizedConclusion === "FAILURE" ||
    normalizedConclusion === "TIMED_OUT" ||
    normalizedConclusion === "CANCELLED" ||
    normalizedConclusion === "ACTION_REQUIRED" ||
    normalizedConclusion === "STALE" ||
    normalizedConclusion === "STARTUP_FAILURE"
  ) {
    return "failed";
  }

  return normalizedStatus === "COMPLETED" ? "failed" : "pending";
}

function mapStatusContextState(state: string | undefined): CICheck["status"] {
  const normalizedState = state?.toUpperCase();
  if (normalizedState === "SUCCESS") return "passed";
  if (normalizedState === "PENDING" || normalizedState === "EXPECTED") return "pending";
  if (normalizedState === "FAILURE" || normalizedState === "ERROR") return "failed";
  return "failed";
}

function mapStatusCheckRollup(items: StatusCheckRollupItem[]): CICheck[] {
  return items.flatMap((item) => {
    if (item.__typename === "CheckRun") {
      const name = item.name?.trim();
      if (!name) return [];
      const status = mapCheckRunStatus(item.status, item.conclusion);
      const conclusion = item.conclusion?.toUpperCase() || item.status?.toUpperCase() || undefined;
      return [
        {
          name,
          status,
          url: item.detailsUrl || undefined,
          conclusion,
          startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
          completedAt: item.completedAt ? new Date(item.completedAt) : undefined,
        },
      ];
    }

    const name = item.context?.trim();
    if (!name) return [];
    const status = mapStatusContextState(item.state);
    return [
      {
        name,
        status,
        url: item.targetUrl || undefined,
        conclusion: item.state?.toUpperCase() || undefined,
        startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
        completedAt: undefined,
      },
    ];
  });
}

function pickBestPR<T extends { state?: string; updatedAt?: string; createdAt?: string }>(
  prs: T[],
): T | null {
  if (prs.length === 0) return null;

  return [...prs].sort((a, b) => {
    const aOpen = (a.state ?? "").toUpperCase() === "OPEN" ? 1 : 0;
    const bOpen = (b.state ?? "").toUpperCase() === "OPEN" ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;

    const updatedDiff = parseDate(b.updatedAt).getTime() - parseDate(a.updatedAt).getTime();
    if (updatedDiff !== 0) return updatedDiff;

    return parseDate(b.createdAt).getTime() - parseDate(a.createdAt).getTime();
  })[0] ?? null;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitHubSCM(): SCM {
  return {
    name: "github",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const parts = project.repo.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${project.repo}", expected "owner/repo"`);
      }
      const [owner, repo] = parts;

      try {
        const branchCandidates = [session.branch];

        for (const branch of branchCandidates) {
          const raw = await gh([
            "pr",
            "list",
            "--repo",
            project.repo,
            "--search",
            `head:${branch}`,
            "--state",
            "all",
            "--json",
            "number,url,title,headRefName,baseRefName,isDraft,state,createdAt,updatedAt",
            "--limit",
            "20",
          ]);

          const prs: Array<{
            number: number;
            url: string;
            title: string;
            headRefName: string;
            baseRefName: string;
            isDraft: boolean;
            state: string;
            createdAt: string;
            updatedAt: string;
          }> = JSON.parse(raw);

          const pr = pickBestPR(prs);
          if (!pr) continue;

          return {
            number: pr.number,
            url: pr.url,
            title: pr.title,
            owner,
            repo,
            branch: pr.headRefName,
            baseBranch: pr.baseRefName,
            isDraft: pr.isDraft,
          };
        }

        const liveBranch = await getLiveBranch(session.workspacePath);
        if (!liveBranch || branchCandidates.includes(liveBranch)) return null;

        const raw = await gh([
          "pr",
          "list",
          "--repo",
          project.repo,
          "--search",
          `head:${liveBranch}`,
          "--state",
          "all",
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft,state,createdAt,updatedAt",
          "--limit",
          "20",
        ]);

        const prs: Array<{
          number: number;
          url: string;
          title: string;
          headRefName: string;
          baseRefName: string;
          isDraft: boolean;
          state: string;
          createdAt: string;
          updatedAt: string;
        }> = JSON.parse(raw);

        const pr = pickBestPR(prs);
        if (!pr) return null;

        return {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          owner,
          repo,
          branch: pr.headRefName,
          baseBranch: pr.baseRefName,
          isDraft: pr.isDraft,
        };

        return null;
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state",
      ]);
      const data: { state: string } = JSON.parse(raw);
      const s = data.state.toUpperCase();
      if (s === "MERGED") return "merged";
      if (s === "CLOSED") return "closed";
      return "open";
    },

    async getPRSummary(pr: PRInfo) {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state,title,additions,deletions",
      ]);
      const data: {
        state: string;
        title: string;
        additions: number;
        deletions: number;
      } = JSON.parse(raw);
      const s = data.state.toUpperCase();
      const state: PRState = s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : "open";
      return {
        state,
        title: data.title ?? "",
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";

      await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag, "--delete-branch"]);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const raw = await gh([
          "pr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "statusCheckRollup",
        ]);

        const data: { statusCheckRollup?: StatusCheckRollupItem[] | null } = JSON.parse(raw);
        return mapStatusCheckRollup(data.statusCheckRollup ?? []);
      } catch (err) {
        // Propagate so callers (getCISummary) can decide how to handle.
        // Do NOT silently return [] — that causes a fail-open where CI
        // appears healthy when we simply failed to fetch check status.
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch {
        // Before fail-closing, check if the PR is merged/closed —
        // GitHub may not return check data for those, and reporting
        // "failing" for a merged PR is wrong.
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch {
          // Can't determine state either; fall through to fail-closed.
        }
        // Fail closed for open PRs: report as failing rather than
        // "none" (which getMergeability treats as passing).
        return "failing";
      }
      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return "pending";

      // Only report passing if at least one check actually passed
      // (not all skipped)
      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return "none";

      return "passing";
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviews",
      ]);
      const data: {
        reviews: Array<{
          author: { login: string };
          state: string;
          body: string;
          submittedAt: string;
        }>;
      } = JSON.parse(raw);

      return data.reviews.map((r) => {
        let state: Review["state"];
        const s = r.state?.toUpperCase();
        if (s === "APPROVED") state = "approved";
        else if (s === "CHANGES_REQUESTED") state = "changes_requested";
        else if (s === "DISMISSED") state = "dismissed";
        else if (s === "PENDING") state = "pending";
        else state = "commented";

        return {
          author: r.author?.login ?? "unknown",
          state,
          body: r.body || undefined,
          submittedAt: parseDate(r.submittedAt),
        };
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviewDecision",
      ]);
      const data: { reviewDecision: string } = JSON.parse(raw);

      const d = (data.reviewDecision ?? "").toUpperCase();
      if (d === "APPROVED") return "approved";
      if (d === "CHANGES_REQUESTED") return "changes_requested";
      if (d === "REVIEW_REQUIRED") return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        // Use GraphQL with variables to get review threads with actual isResolved status
        const raw = await gh([
          "api",
          "graphql",
          "-f",
          `owner=${pr.owner}`,
          "-f",
          `name=${pr.repo}`,
          "-F",
          `number=${pr.number}`,
          "-f",
          `query=query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100) {
                  nodes {
                    isResolved
                    comments(first: 1) {
                      nodes {
                        id
                        author { login }
                        body
                        path
                        line
                        url
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          }`,
        ]);

        const data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array<{
                    isResolved: boolean;
                    comments: {
                      nodes: Array<{
                        id: string;
                        author: { login: string } | null;
                        body: string;
                        path: string | null;
                        line: number | null;
                        url: string;
                        createdAt: string;
                      }>;
                    };
                  }>;
                };
              };
            };
          };
        } = JSON.parse(raw);

        const threads = data.data.repository.pullRequest.reviewThreads.nodes;

        return threads
          .filter((t) => {
            if (t.isResolved) return false; // only pending (unresolved) threads
            const c = t.comments.nodes[0];
            if (!c) return false; // skip threads with no comments
            return !isKnownBotAuthor(c.author?.login);
          })
          .map((t) => {
            const c = t.comments.nodes[0];
            return {
              id: c.id,
              author: c.author?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? undefined,
              isResolved: t.isResolved,
              createdAt: parseDate(c.createdAt),
              url: c.url,
            };
          });
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        // Fetch all review comments with max page size (100 is GitHub's limit)
        const raw = await gh([
          "api",
          "-F",
          "per_page=100",
          `repos/${repoFlag(pr)}/pulls/${pr.number}/comments`,
        ]);

        const comments: Array<{
          id: number;
          user: { login: string };
          body: string;
          path: string;
          line: number | null;
          original_line: number | null;
          created_at: string;
          html_url: string;
        }> = JSON.parse(raw);

        return comments
          .filter((c) => isKnownBotAuthor(c.user?.login))
          .map((c) => {
            // Determine severity from body content
            let severity: AutomatedComment["severity"] = "info";
            const bodyLower = c.body.toLowerCase();
            if (
              bodyLower.includes("error") ||
              bodyLower.includes("bug") ||
              bodyLower.includes("critical") ||
              bodyLower.includes("potential issue")
            ) {
              severity = "error";
            } else if (
              bodyLower.includes("warning") ||
              bodyLower.includes("suggest") ||
              bodyLower.includes("consider")
            ) {
              severity = "warning";
            }

            return {
              id: String(c.id),
              botName: c.user?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? c.original_line ?? undefined,
              severity,
              createdAt: parseDate(c.created_at),
              url: c.html_url,
            };
          });
      } catch {
        return [];
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      // First, check if the PR is merged
      // GitHub returns mergeable=null for merged PRs, which is not useful
      // Note: We only skip checks for merged PRs. Closed PRs still need accurate status.
      const state = await this.getPRState(pr);
      if (state === "merged") {
        // For merged PRs, return a clean result without querying mergeable status
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

      // Fetch PR details with merge state
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "mergeable,reviewDecision,mergeStateStatus,isDraft",
      ]);

      const data: {
        mergeable: string;
        reviewDecision: string;
        mergeStateStatus: string;
        isDraft: boolean;
      } = JSON.parse(raw);

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = (data.reviewDecision ?? "").toUpperCase();
      const approved = reviewDecision === "APPROVED";
      if (reviewDecision === "CHANGES_REQUESTED") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "REVIEW_REQUIRED") {
        blockers.push("Review required");
      }

      // Conflicts / merge state
      const mergeable = (data.mergeable ?? "").toUpperCase();
      const mergeState = (data.mergeStateStatus ?? "").toUpperCase();
      const noConflicts = mergeable === "MERGEABLE";
      if (mergeable === "CONFLICTING") {
        blockers.push("Merge conflicts");
      } else if (mergeable === "UNKNOWN" || mergeable === "") {
        blockers.push("Merge status unknown (GitHub is computing)");
      }
      if (mergeState === "BEHIND") {
        blockers.push("Branch is behind base branch");
      } else if (mergeState === "BLOCKED") {
        blockers.push("Merge is blocked by branch protection");
      } else if (mergeState === "UNSTABLE") {
        blockers.push("Required checks are failing");
      }

      // Draft
      if (data.isDraft) {
        blockers.push("PR is still a draft");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "scm" as const,
  description: "SCM plugin: GitHub PRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitHubSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
