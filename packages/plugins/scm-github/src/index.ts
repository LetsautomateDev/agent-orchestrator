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
  type PRSnapshot,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

/** Known bot logins that produce automated review comments */
const BOT_AUTHORS = new Set([
  "cursor[bot]",
  "github-actions[bot]",
  "greptile-apps",
  "greptile[bot]",
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
  return (login ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
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

function isGreptileAuthor(login: string | null | undefined): boolean {
  return normalizeAuthorLogin(login).startsWith("greptile");
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

function mapCheckRunStatus(
  status: string | undefined,
  conclusion: string | undefined,
): CICheck["status"] {
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

function mapPRState(state: string | undefined): PRState {
  const normalized = state?.toUpperCase();
  if (normalized === "MERGED") return "merged";
  if (normalized === "CLOSED") return "closed";
  return "open";
}

function mapReviewDecisionValue(reviewDecision: string | undefined | null): ReviewDecision {
  const normalized = (reviewDecision ?? "").toUpperCase();
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "REVIEW_REQUIRED") return "pending";
  return "none";
}

function summarizeCIStatus(checks: CICheck[]): CIStatus {
  if (checks.length === 0) return "none";

  const hasFailing = checks.some((c) => c.status === "failed");
  if (hasFailing) return "failing";

  const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
  if (hasPending) return "pending";

  const hasPassing = checks.some((c) => c.status === "passed");
  if (!hasPassing) return "none";

  return "passing";
}

function isGreptileCheck(check: Pick<CICheck, "name">): boolean {
  return check.name.toLowerCase().includes("greptile");
}

function getGreptileCheckState(checks: CICheck[]): "none" | "pending" | "failed" | "passed" {
  const greptileChecks = checks.filter(isGreptileCheck);
  if (greptileChecks.length === 0) return "none";
  if (greptileChecks.some((check) => check.status === "failed")) return "failed";
  if (greptileChecks.some((check) => check.status === "pending" || check.status === "running")) {
    return "pending";
  }
  if (greptileChecks.some((check) => check.status === "passed")) return "passed";
  return "none";
}

function extractGreptileScore(body: string | undefined | null): number | null {
  const text = (body ?? "").trim();
  if (!text) return null;

  const confidenceMatch = text.match(/confidence\s+score[^0-9]*([0-5](?:\.\d+)?)\s*\/\s*5/i);
  if (confidenceMatch) {
    return Number(confidenceMatch[1]);
  }

  const genericMatch = text.match(/\b([0-5](?:\.\d+)?)\s*\/\s*5\b/);
  if (genericMatch) {
    return Number(genericMatch[1]);
  }

  return null;
}

async function fetchLatestGreptileScore(pr: PRInfo): Promise<number | null> {
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
      author?: { login?: string | null } | null;
      body?: string | null;
      submittedAt?: string | null;
    }>;
  } = JSON.parse(raw);

  const latestGreptileReview = [...(data.reviews ?? [])]
    .filter((review) => isGreptileAuthor(review.author?.login))
    .sort((a, b) => parseDate(b.submittedAt).getTime() - parseDate(a.submittedAt).getTime())[0];

  if (!latestGreptileReview) return null;
  return extractGreptileScore(latestGreptileReview.body);
}

function getGreptileBlocker(opts: { checks: CICheck[]; score: number | null }): string | null {
  const checkState = getGreptileCheckState(opts.checks);
  const greptilePresent = checkState !== "none" || opts.score !== null;
  if (!greptilePresent) return null;

  if (checkState === "failed") return "Greptile check failed";
  if (checkState === "pending") return "Greptile review pending";
  if (opts.score === null) return "Awaiting Greptile score";
  if (opts.score < 5) return `Greptile confidence score ${opts.score}/5 (requires 5/5)`;
  return null;
}

function buildMergeReadiness(opts: {
  state: PRState;
  ciStatus: CIStatus;
  reviewDecision: ReviewDecision;
  mergeable: string | undefined;
  mergeStateStatus: string | undefined;
  isDraft: boolean;
  extraBlockers?: string[];
}): MergeReadiness {
  if (opts.state === "merged") {
    return {
      mergeable: true,
      ciPassing: true,
      approved: true,
      noConflicts: true,
      blockers: [],
    };
  }

  const blockers: string[] = [];
  const ciPassing = opts.ciStatus === CI_STATUS.PASSING || opts.ciStatus === CI_STATUS.NONE;
  if (!ciPassing && opts.state === "open") {
    blockers.push(`CI is ${opts.ciStatus}`);
  }

  const approved = opts.reviewDecision === "approved";
  if (opts.reviewDecision === "changes_requested") {
    blockers.push("Changes requested in review");
  } else if (opts.reviewDecision === "pending") {
    blockers.push("Review required");
  }

  const mergeable = (opts.mergeable ?? "").toUpperCase();
  const mergeState = (opts.mergeStateStatus ?? "").toUpperCase();
  const noConflicts = mergeable === "MERGEABLE" || opts.state !== "open";
  if (opts.state === "open") {
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
    if (opts.isDraft) {
      blockers.push("PR is still a draft");
    }
  }

  for (const blocker of opts.extraBlockers ?? []) {
    if (blocker && !blockers.includes(blocker)) {
      blockers.push(blocker);
    }
  }

  return {
    mergeable: opts.state === "open" ? blockers.length === 0 : false,
    ciPassing,
    approved,
    noConflicts,
    blockers,
  };
}

function isRateLimitError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return message.includes("rate limit") || message.includes("secondary rate limit");
}

function cloneReviewComment(comment: ReviewComment): ReviewComment {
  return {
    ...comment,
    createdAt: new Date(comment.createdAt),
  };
}

function cloneAutomatedComment(comment: AutomatedComment): AutomatedComment {
  return {
    ...comment,
    createdAt: new Date(comment.createdAt),
  };
}

function cloneCheck(check: CICheck): CICheck {
  return {
    ...check,
    startedAt: check.startedAt ? new Date(check.startedAt) : undefined,
    completedAt: check.completedAt ? new Date(check.completedAt) : undefined,
  };
}

function cloneSnapshot(snapshot: PRSnapshot): PRSnapshot {
  return {
    ...snapshot,
    updatedAt: new Date(snapshot.updatedAt),
    ciChecks: snapshot.ciChecks.map(cloneCheck),
    mergeability: {
      ...snapshot.mergeability,
      blockers: [...snapshot.mergeability.blockers],
    },
    pendingComments: snapshot.pendingComments.map(cloneReviewComment),
    automatedComments: snapshot.automatedComments.map(cloneAutomatedComment),
  };
}

async function fetchPendingCommentsRaw(pr: PRInfo): Promise<ReviewComment[]> {
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
      if (t.isResolved) return false;
      const c = t.comments.nodes[0];
      if (!c) return false;
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
}

async function fetchAutomatedCommentsRaw(pr: PRInfo): Promise<AutomatedComment[]> {
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
}

function addGreptileSummaryComment(
  automatedComments: AutomatedComment[],
  greptileBlocker: string | null,
  pr: PRInfo,
): AutomatedComment[] {
  if (
    !greptileBlocker ||
    greptileBlocker === "Greptile review pending" ||
    automatedComments.some((comment) => isGreptileAuthor(comment.botName))
  ) {
    return automatedComments;
  }

  return [
    ...automatedComments,
    {
      id: `greptile-summary-${pr.number}`,
      botName: "greptile-apps",
      body: greptileBlocker,
      severity: "warning",
      createdAt: new Date(),
      url: pr.url,
    },
  ];
}

function pickBestPR<T extends { state?: string; updatedAt?: string; createdAt?: string }>(
  prs: T[],
): T | null {
  if (prs.length === 0) return null;

  return (
    [...prs].sort((a, b) => {
      const aOpen = (a.state ?? "").toUpperCase() === "OPEN" ? 1 : 0;
      const bOpen = (b.state ?? "").toUpperCase() === "OPEN" ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;

      const updatedDiff = parseDate(b.updatedAt).getTime() - parseDate(a.updatedAt).getTime();
      if (updatedDiff !== 0) return updatedDiff;

      return parseDate(b.createdAt).getTime() - parseDate(a.createdAt).getTime();
    })[0] ?? null
  );
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitHubSCM(): SCM {
  const SNAPSHOT_TTL_MS = 45_000;
  const RATE_LIMIT_BASE_BACKOFF_MS = 30_000;
  const RATE_LIMIT_MAX_BACKOFF_MS = 5 * 60_000;

  const snapshotCache = new Map<string, { snapshot: PRSnapshot; expiresAt: number }>();
  const snapshotBackoff = new Map<string, { delayMs: number; retryAt: number }>();

  function snapshotKey(pr: PRInfo): string {
    return `${repoFlag(pr)}#${pr.number}`;
  }

  function getFreshSnapshot(key: string): PRSnapshot | null {
    const entry = snapshotCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return cloneSnapshot(entry.snapshot);
  }

  function getStaleSnapshot(key: string): PRSnapshot | null {
    const entry = snapshotCache.get(key);
    return entry ? cloneSnapshot(entry.snapshot) : null;
  }

  function cacheSnapshot(key: string, snapshot: PRSnapshot, ttlMs = SNAPSHOT_TTL_MS): PRSnapshot {
    const cloned = cloneSnapshot(snapshot);
    snapshotCache.set(key, {
      snapshot: cloned,
      expiresAt: Date.now() + ttlMs,
    });
    return cloneSnapshot(cloned);
  }

  function markRateLimited(
    key: string,
    staleSnapshot: PRSnapshot | null,
    error: unknown,
  ): PRSnapshot | null {
    if (!isRateLimitError(error)) return null;

    const prev = snapshotBackoff.get(key);
    const delayMs = Math.min(
      prev ? prev.delayMs * 2 : RATE_LIMIT_BASE_BACKOFF_MS,
      RATE_LIMIT_MAX_BACKOFF_MS,
    );
    snapshotBackoff.set(key, {
      delayMs,
      retryAt: Date.now() + delayMs,
    });

    if (!staleSnapshot) return null;

    const rateLimitedSnapshot = cloneSnapshot(staleSnapshot);
    rateLimitedSnapshot.rateLimited = true;
    return cacheSnapshot(key, rateLimitedSnapshot, delayMs);
  }

  async function fetchPRSnapshot(pr: PRInfo): Promise<PRSnapshot> {
    const key = snapshotKey(pr);
    const fresh = getFreshSnapshot(key);
    if (fresh) return fresh;

    const backoff = snapshotBackoff.get(key);
    const stale = getStaleSnapshot(key);
    if (backoff && Date.now() < backoff.retryAt && stale) {
      stale.rateLimited = true;
      return stale;
    }

    try {
      const prViewPromise = gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state,title,additions,deletions,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,updatedAt",
      ]);

      const [prViewRaw, pendingR, automatedR, greptileR] = await Promise.all([
        prViewPromise,
        Promise.allSettled([
          fetchPendingCommentsRaw(pr),
          fetchAutomatedCommentsRaw(pr),
          fetchLatestGreptileScore(pr),
        ]),
      ]).then(([summary, settled]) => [summary, settled[0], settled[1], settled[2]] as const);

      const summary: {
        state: string;
        title: string;
        additions: number;
        deletions: number;
        isDraft: boolean;
        reviewDecision: string;
        mergeable: string;
        mergeStateStatus: string;
        statusCheckRollup?: StatusCheckRollupItem[] | null;
        updatedAt?: string;
      } = JSON.parse(prViewRaw);

      const state = mapPRState(summary.state);
      const ciChecks = mapStatusCheckRollup(summary.statusCheckRollup ?? []);
      const ciStatus = summarizeCIStatus(ciChecks);
      const reviewDecision = mapReviewDecisionValue(summary.reviewDecision);
      const greptileScore = greptileR.status === "fulfilled" ? greptileR.value : null;
      const greptileBlocker = getGreptileBlocker({
        checks: ciChecks,
        score: greptileScore,
      });

      let rateLimited = false;
      let pendingComments = stale?.pendingComments ?? [];
      if (pendingR.status === "fulfilled") {
        pendingComments = pendingR.value;
      } else if (isRateLimitError(pendingR.reason)) {
        rateLimited = true;
      } else {
        pendingComments = [];
      }

      let automatedComments = stale?.automatedComments ?? [];
      if (automatedR.status === "fulfilled") {
        automatedComments = automatedR.value;
      } else if (isRateLimitError(automatedR.reason)) {
        rateLimited = true;
      } else {
        automatedComments = [];
      }
      if (greptileR.status === "rejected" && isRateLimitError(greptileR.reason)) {
        rateLimited = true;
      }
      automatedComments = addGreptileSummaryComment(automatedComments, greptileBlocker, pr);

      const snapshot: PRSnapshot = {
        state,
        title: summary.title ?? pr.title,
        additions: summary.additions ?? 0,
        deletions: summary.deletions ?? 0,
        isDraft: summary.isDraft ?? pr.isDraft,
        ciStatus,
        ciChecks,
        reviewDecision,
        mergeability: buildMergeReadiness({
          state,
          ciStatus,
          reviewDecision,
          mergeable: summary.mergeable,
          mergeStateStatus: summary.mergeStateStatus,
          isDraft: summary.isDraft ?? pr.isDraft,
          extraBlockers: greptileBlocker ? [greptileBlocker] : [],
        }),
        pendingComments,
        automatedComments,
        updatedAt: parseDate(summary.updatedAt),
        rateLimited,
      };

      snapshotBackoff.delete(key);
      return cacheSnapshot(
        key,
        snapshot,
        rateLimited ? RATE_LIMIT_BASE_BACKOFF_MS : SNAPSHOT_TTL_MS,
      );
    } catch (error) {
      const rateLimitedSnapshot = markRateLimited(key, stale, error);
      if (rateLimitedSnapshot) return rateLimitedSnapshot;
      throw error;
    }
  }

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

    async getPRSnapshot(pr: PRInfo): Promise<PRSnapshot> {
      return fetchPRSnapshot(pr);
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
      return mapReviewDecisionValue(data.reviewDecision);
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        return await fetchPendingCommentsRaw(pr);
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        return await fetchAutomatedCommentsRaw(pr);
      } catch {
        return [];
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      return (await fetchPRSnapshot(pr)).mergeability;
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
