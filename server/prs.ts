import { execCommand } from "@getpaseo/plugin/server";
import type { PullRequest } from "../shared/contracts";

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const CACHE_MS = 55_000;
const FIELDS =
  "number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefName,comments,reviews";

interface GhFeedback {
  author: { login: string } | null;
  body: string;
  state?: string;
}

interface GhPr {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null;
  statusCheckRollup: { conclusion?: string | null; state?: string | null }[] | null;
  headRefName: string;
  comments: GhFeedback[] | null;
  reviews: GhFeedback[] | null;
}

/** A pull request plus the activity the subscription watcher compares between polls. */
export interface PrDetail {
  pr: Omit<PullRequest, "followed">;
  feedbackCount: number;
  latestFeedback: string | null;
}

const cache = new Map<string, { at: number; detail: PrDetail | null }>();

export function prUrlsIn(text: string): string[] {
  return [...new Set(text.match(PR_URL) ?? [])];
}

/**
 * Looks up pull requests by URL, plus the PR for the current branch of each checkout.
 * Uses the daemon user's `gh` login; anything gh cannot see is skipped.
 */
export async function lookupPrDetails(urls: readonly string[], checkouts: readonly string[]) {
  const results = await Promise.all([
    ...urls.map((url) => cached(url, () => ghView([url]))),
    ...checkouts.map((cwd) => cached(`cwd:${cwd}`, () => ghView([], cwd))),
  ]);
  const byUrl = new Map<string, PrDetail>();
  for (const detail of results) if (detail) byUrl.set(detail.pr.url, detail);
  return [...byUrl.values()].sort((a, b) => b.pr.number - a.pr.number);
}

async function cached(key: string, load: () => Promise<PrDetail | null>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.detail;
  const detail = await load();
  cache.set(key, { at: Date.now(), detail });
  return detail;
}

async function ghView(args: string[], cwd?: string): Promise<PrDetail | null> {
  try {
    const { stdout } = await execCommand("gh", ["pr", "view", ...args, "--json", FIELDS], {
      cwd,
      timeout: 15_000,
    });
    return toDetail(JSON.parse(stdout) as GhPr);
  } catch {
    // No PR for that branch, not a GitHub checkout, or gh has no access.
    return null;
  }
}

function toDetail(pr: GhPr): PrDetail {
  const feedback = [...(pr.comments ?? []), ...(pr.reviews ?? []).filter((review) => review.body || review.state)];
  const latest = feedback[feedback.length - 1];
  return {
    pr: {
      number: pr.number,
      title: pr.title.split("\n")[0].trim(),
      url: pr.url,
      branch: pr.headRefName,
      state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
      group: groupOf(pr),
    },
    feedbackCount: feedback.length,
    latestFeedback: latest ? summarise(latest) : null,
  };
}

function summarise({ author, body, state }: GhFeedback) {
  const who = author?.login ?? "someone";
  const text = body.replace(/\s+/g, " ").trim();
  const what = state && state !== "COMMENTED" ? `${state.toLowerCase().replace(/_/g, " ")}` : "commented";
  return `${who} ${what}${text ? `: ${text.length > 240 ? `${text.slice(0, 240)}…` : text}` : ""}`;
}

/** Groups open PRs by what they need next. */
function groupOf(pr: GhPr): PullRequest["group"] {
  if (pr.state === "MERGED") return "Merged";
  if (pr.state === "CLOSED") return "Closed";
  if (pr.isDraft) return "Draft";
  if (pr.mergeable === "CONFLICTING") return "Merge conflicts";
  const checks = pr.statusCheckRollup ?? [];
  const failing = checks.some((check) =>
    ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(
      (check.conclusion ?? check.state ?? "").toUpperCase(),
    ),
  );
  if (failing) return "Checks failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (pr.reviewDecision === "APPROVED") return "Approved";
  return "Awaiting review";
}
