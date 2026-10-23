import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { Network } from "./network.js";
import {
  ExecutionError,
  emptyUsage,
  type Connector,
  type ResolvedStep,
  type Verification,
} from "./domain.js";
import type { VerificationResult } from "./executors.js";

const Issue = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  html_url: z.string().url(),
  user: z.object({ id: z.number().int().positive() }),
  pull_request: z.unknown().optional(),
});
type Target = { owner: string; repo: string; caseId: string };
export function githubMarker(
  store: Store,
  workspace: string,
  connector: Connector,
  target: Target,
) {
  const digest = createHmac("sha256", store.config.masterKey)
    .update(
      JSON.stringify([
        workspace,
        connector.id,
        target.owner.toLowerCase(),
        target.repo.toLowerCase(),
        target.caseId,
      ]),
    )
    .digest("hex");
  return `<!-- agent-operations:${digest} -->`;
}
export function githubBody(body: string, marker: string) {
  return body + "\n\n" + marker;
}
export class Github {
  constructor(
    private store: Store,
    public network = new Network(store.config),
  ) {}
  async request(
    connector: Connector,
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ) {
    const result = await this.network.http(
      this.network.path(connector.base_url, path),
      {
        method: body === undefined ? "GET" : "POST",
        body,
        write: body !== undefined,
        signal,
        headers: {
          ...this.store.connectorHeaders(connector),
          accept: "application/vnd.github+json",
          "user-agent": "Agent-Operations/0.2",
          "X-GitHub-Api-Version": "2022-11-28",
          "content-type": "application/json",
        },
      },
    );
    if (result.status >= 400)
      throw new ExecutionError(
        result.status === 401 || result.status === 403
          ? "GitHub access unavailable; check credentials, permissions and rate limits"
          : `GitHub returned HTTP ${result.status}`,
        body !== undefined,
        result.status === 429 || result.status >= 500,
        result.usage,
      );
    return result;
  }
  async create(
    workspace: string,
    step: Extract<ResolvedStep, { kind: "github_issue" }>,
    signal: AbortSignal,
  ) {
    const connector = await this.store.connector(workspace, step.connection);
    this.store.checkBinding(connector, step.connections?.action);
    if (step.action === "wait") return { output: null, usage: emptyUsage() };
    const marker = githubMarker(this.store, workspace, connector, step);
    const result = await this.request(
      connector,
      `/repos/${step.owner}/${step.repo}/issues`,
      signal,
      { title: step.issueTitle, body: githubBody(step.body, marker) },
    );
    const issue = Issue.parse(result.body);
    return {
      output: { id: issue.id, number: issue.number },
      usage: result.usage,
    };
  }
  async verify(
    workspace: string,
    v: Extract<Verification, { kind: "github_issue" }>,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    const connector = await this.store.connector(workspace, v.connection);
    const marker = githubMarker(this.store, workspace, connector, v);
    const usage = emptyUsage();
    const get = async (path: string) => {
      const result = await this.request(connector, path, signal);
      usage.httpRequests += result.usage.httpRequests;
      return result.body;
    };
    const prefix = `/repos/${v.owner}/${v.repo}/issues`;
    const matches: z.infer<typeof Issue>[] = [];
    if (v.number !== undefined) {
      const number = z.coerce.number().int().positive().parse(v.number);
      matches.push(Issue.parse(await get(`${prefix}/${number}`)));
    } else {
      // No search-index dependency. A missing match never authorizes another POST.
      for (let page = 1; page <= 10; page++) {
        const issues = z
          .array(Issue)
          .parse(
            await get(
              `${prefix}?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
            ),
          );
        matches.push(
          ...issues.filter((i) => !i.pull_request && i.body?.includes(marker)),
        );
        if (issues.length < 100) break;
        if (page === 10)
          return {
            status: "unknown",
            reason:
              "Recovery scan limit reached; narrow the investigation manually",
            usage,
          };
      }
    }
    if (matches.length !== 1)
      return {
        status: "unknown",
        reason: matches.length
          ? "Multiple issues match this case; human review required"
          : "Issue not yet confirmed; no write will be replayed",
        usage,
      };
    const issue = matches[0]!;
    // Pin provider account and complete payload, not only a search marker.
    const user = z
      .object({ id: z.number().int().positive() })
      .parse(await get("/user"));
    if (
      issue.pull_request ||
      issue.user.id !== user.id ||
      issue.title !== v.title ||
      issue.body !== githubBody(v.body, marker)
    )
      return {
        status: "unknown",
        reason: "Issue identity or content differs from the approved request",
        usage,
      };
    const expectedUrl = `https://github.com/${v.owner}/${v.repo}/issues/${issue.number}`;
    if (issue.html_url.toLowerCase() !== expectedUrl.toLowerCase())
      return { status: "unknown", reason: "Unexpected issue URL", usage };
    const output = {
      id: issue.id,
      number: issue.number,
      url: expectedUrl,
      state: issue.state,
      stateReason: issue.state_reason || null,
      caseId: v.caseId,
      checkedAt: new Date().toISOString(),
    };
    if (
      v.waitForCompleted &&
      (issue.state !== "closed" || issue.state_reason !== "completed")
    )
      return {
        status: "pending",
        output,
        reason:
          issue.state === "closed"
            ? "Issue closed without completed resolution; awaiting completed state"
            : "Waiting for issue to be closed as completed",
        usage,
      };
    return { status: "confirmed", output, usage };
  }
}
