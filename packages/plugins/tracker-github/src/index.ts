/**
 * tracker-github plugin — GitHub Issues as an issue tracker.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

const ISSUE_JSON_FIELDS = "number,title,body,url,state,stateReason,labels,assignees";
const ISSUE_JSON_FIELDS_LEGACY = "number,title,body,url,state,labels,assignees";

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

function isUnsupportedStateReasonError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Unknown JSON field: "stateReason"');
}

interface GitHubIssueData {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  stateReason?: string | null;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
}

async function getIssueData(identifier: string, project: ProjectConfig): Promise<GitHubIssueData> {
  const baseArgs = ["issue", "view", identifier, "--repo", project.repo, "--json"];

  try {
    const raw = await gh([...baseArgs, ISSUE_JSON_FIELDS]);
    return JSON.parse(raw) as GitHubIssueData;
  } catch (err) {
    if (!isUnsupportedStateReasonError(err)) throw err;
    const raw = await gh([...baseArgs, ISSUE_JSON_FIELDS_LEGACY]);
    return JSON.parse(raw) as GitHubIssueData;
  }
}

async function listIssueData(
  filters: IssueFilters,
  project: ProjectConfig,
): Promise<GitHubIssueData[]> {
  const baseArgs = [
    "issue",
    "list",
    "--repo",
    project.repo,
    "--json",
    ISSUE_JSON_FIELDS,
    "--limit",
    String(filters.limit ?? 30),
  ];

  const buildArgs = (jsonFields: string): string[] => {
    const args = [...baseArgs];
    args[5] = jsonFields;

    if (filters.state === "closed") {
      args.push("--state", "closed");
    } else if (filters.state === "all") {
      args.push("--state", "all");
    } else {
      args.push("--state", "open");
    }

    if (filters.labels && filters.labels.length > 0) {
      args.push("--label", filters.labels.join(","));
    }

    if (filters.assignee) {
      args.push("--assignee", filters.assignee);
    }

    return args;
  };

  try {
    const raw = await gh(buildArgs(ISSUE_JSON_FIELDS));
    return JSON.parse(raw) as GitHubIssueData[];
  } catch (err) {
    if (!isUnsupportedStateReasonError(err)) throw err;
    const raw = await gh(buildArgs(ISSUE_JSON_FIELDS_LEGACY));
    return JSON.parse(raw) as GitHubIssueData[];
  }
}

function mapState(ghState: string, stateReason?: string | null): Issue["state"] {
  const s = ghState.toUpperCase();
  if (s === "CLOSED") {
    if (stateReason?.toUpperCase() === "NOT_PLANNED") return "cancelled";
    return "closed";
  }
  return "open";
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createGitHubTracker(): Tracker {
  return {
    name: "github",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const data = await getIssueData(identifier, project);

      return {
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const raw = await gh([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--json",
        "state",
      ]);
      const data: { state: string } = JSON.parse(raw);
      return data.state.toUpperCase() === "CLOSED";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `https://github.com/${project.repo}/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue number from GitHub URL
      // Example: https://github.com/owner/repo/issues/42 → "#42"
      const match = url.match(/\/issues\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `feat/issue-${num}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on GitHub issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const issues = await listIssueData(filters, project);

      return issues.map((data) => ({
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      // Handle state change — GitHub Issues only supports open/closed.
      // "in_progress" is not a GitHub state, so it is intentionally a no-op.
      if (update.state === "closed") {
        await gh(["issue", "close", identifier, "--repo", project.repo]);
      } else if (update.state === "open") {
        await gh(["issue", "reopen", identifier, "--repo", project.repo]);
      }

      // Handle label changes
      if (update.labels && update.labels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--add-label",
          update.labels.join(","),
        ]);
      }

      // Handle assignee changes
      if (update.assignee) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--add-assignee",
          update.assignee,
        ]);
      }

      // Handle comment
      if (update.comment) {
        await gh([
          "issue",
          "comment",
          identifier,
          "--repo",
          project.repo,
          "--body",
          update.comment,
        ]);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const args = [
        "issue",
        "create",
        "--repo",
        project.repo,
        "--title",
        input.title,
        "--body",
        input.description ?? "",
      ];

      if (input.labels && input.labels.length > 0) {
        args.push("--label", input.labels.join(","));
      }

      if (input.assignee) {
        args.push("--assignee", input.assignee);
      }

      // gh issue create outputs the URL of the new issue
      const url = await gh(args);

      // Extract issue number from URL and fetch full details
      const match = url.match(/\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Failed to parse issue URL from gh output: ${url}`);
      }
      const number = match[1];

      return this.getIssue(number, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "tracker" as const,
  description: "Tracker plugin: GitHub Issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createGitHubTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
