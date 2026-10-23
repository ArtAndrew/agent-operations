// SPDX-License-Identifier: Apache-2.0
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type RunStatus =
  | "QUEUED"
  | "RUNNING"
  | "RETRYING"
  | "WAITING_EXTERNAL"
  | "WAITING_APPROVAL"
  | "NEEDS_ATTENTION"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";
export interface Run {
  id: string;
  workspace_id: string;
  operation_name: string;
  version: number;
  status: RunStatus;
  input: Record<string, Json>;
  outputs: Record<string, Json>;
  error: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key: string;
}
export interface RunDetail {
  run: Run;
  steps: Array<{
    id: string;
    step_id: string;
    status: string;
    attempts: number;
    resolved: Json;
    output: Json;
    error: string | null;
  }>;
  approvals: Array<{
    id: string;
    step_id: string;
    status: string;
    digest: string;
  }>;
  artifacts: Array<{
    id: string;
    name: string;
    content_type: string;
    size_bytes: number;
    sha256: string;
  }>;
  events: Record<string, Json>[];
  attempts: Record<string, Json>[];
}
export interface OperationDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, Json>;
  steps: Record<string, Json>[];
}
export interface PublishedOperation {
  id: string;
  version: number;
  digest: string;
  definition: OperationDefinition;
}
export class AgentOperationsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AgentOperationsError";
  }
}
export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
export class AgentOperations {
  private baseUrl: string;
  private transport: typeof fetch;
  constructor(private options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Use an HTTP(S) base URL without credentials, query or fragment",
      );
    this.baseUrl = url.href.replace(/\/$/, "");
    this.transport = options.fetch || globalThis.fetch;
  }
  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs || 30000),
      signal = options.signal
        ? AbortSignal.any([deadline, options.signal])
        : deadline;
    const response = await this.transport(this.baseUrl + "/api/v1" + path, {
      method: options.method || "GET",
      headers: {
        Authorization: "Bearer " + this.options.apiKey,
        "Content-Type": "application/json",
        ...options.headers,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
      redirect: "error",
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AgentOperationsError(
        response.status,
        "INVALID_RESPONSE",
        "Server returned a non-JSON response",
      );
    }
    if (!response.ok) {
      const e = (
        data as {
          error?: { code?: string; message?: string; details?: unknown };
        }
      ).error;
      throw new AgentOperationsError(
        response.status,
        e?.code || "REQUEST_FAILED",
        e?.message || "Request failed",
        e?.details,
      );
    }
    return data as T;
  }
  me() {
    return this.request<Record<string, Json>>("/me");
  }
  publish(operation: OperationDefinition) {
    return this.request<PublishedOperation>("/operations", {
      method: "POST",
      body: operation,
    });
  }
  operation(name: string, version?: number) {
    return this.request<PublishedOperation>(
      "/operations/" +
        encodeURIComponent(name) +
        (version ? "?version=" + version : ""),
    );
  }
  packages() {
    return this.request<{
      catalog: Record<string, Json>[];
      items: Record<string, Json>[];
    }>("/packages");
  }
  installGithubPackage(configuration: {
    name: string;
    connection: string;
    owner: string;
    repo: string;
    requireApproval?: boolean;
    waitForCompleted?: boolean;
    pollSeconds?: number;
    maxWaitHours?: number;
  }) {
    return this.request<Record<string, Json>>(
      "/packages/github-issues/install",
      { method: "POST", body: configuration },
    );
  }
  operations() {
    return this.request<{ items: PublishedOperation[] }>("/operations");
  }
  submit(
    operation: string,
    input: Record<string, Json>,
    options: { idempotencyKey: string; version?: number; signal?: AbortSignal },
  ) {
    if (!options.idempotencyKey)
      throw new Error("An idempotency key is required");
    return this.request<{ run: Run; replayed: boolean }>("/runs", {
      method: "POST",
      body: { operation, input, version: options.version },
      headers: { "Idempotency-Key": options.idempotencyKey },
      signal: options.signal,
    });
  }
  run(id: string, signal?: AbortSignal) {
    return this.request<RunDetail>("/runs/" + encodeURIComponent(id), {
      signal,
    });
  }
  runs(options: { status?: RunStatus; limit?: number; before?: string } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options))
      if (value !== undefined) query.set(key, String(value));
    return this.request<{ items: Run[] }>("/runs?" + query);
  }
  cancel(id: string, reason: string) {
    return this.request<{ ok: boolean }>(
      "/runs/" + encodeURIComponent(id) + "/cancel",
      { method: "POST", body: { reason } },
    );
  }
  reconcile(id: string, reason: string) {
    return this.request<{ ok: boolean }>(
      "/runs/" + encodeURIComponent(id) + "/reconcile",
      { method: "POST", body: { reason } },
    );
  }
  resolve(
    id: string,
    decision: {
      outcome: "confirmed" | "failed";
      reason: string;
      evidence: string;
      output?: Json;
    },
  ) {
    return this.request<{ ok: boolean }>(
      "/runs/" + encodeURIComponent(id) + "/resolve",
      { method: "POST", body: decision },
    );
  }
  approvals() {
    return this.request<{ items: Record<string, Json>[] }>("/approvals");
  }
  decide(
    approvalId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string,
  ) {
    return this.request<{ status: string }>(
      "/approvals/" + encodeURIComponent(approvalId) + "/decision",
      { method: "POST", body: { decision, reason } },
    );
  }
  usage() {
    return this.request<Record<string, Json>>("/usage");
  }
  verifyAudit() {
    return this.request<{
      valid: boolean;
      events?: number;
      head?: string;
      firstInvalidEvent?: string;
    }>("/audit/verify");
  }
  connect(connection: {
    name: string;
    kind: "http" | "browser" | "model";
    baseUrl: string;
    headers?: Record<string, string>;
    secretHeaders?: Record<string, string>;
    idempotencyHeader?: string;
  }) {
    return this.request<{ id: string }>("/connectors", {
      method: "POST",
      body: connection,
    });
  }
  rotateCredentials(id: string, secretHeaders: Record<string, string>) {
    return this.request<{ ok: boolean }>(
      "/connectors/" + encodeURIComponent(id) + "/credentials",
      { method: "PUT", body: { secretHeaders } },
    );
  }
  async wait(
    id: string,
    options: {
      timeoutMs?: number;
      pollMs?: number;
      signal?: AbortSignal;
      stopOnDecision?: boolean;
    } = {},
  ): Promise<RunDetail> {
    const deadline = Date.now() + (options.timeoutMs ?? 300000),
      stop = options.stopOnDecision !== false;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const result = await this.run(id, options.signal);
      if (
        ["SUCCEEDED", "FAILED", "CANCELLED"].includes(result.run.status) ||
        (stop &&
          ["WAITING_APPROVAL", "NEEDS_ATTENTION"].includes(result.run.status))
      )
        return result;
      const delay = Math.min(
        options.pollMs ?? 1000,
        Math.max(0, deadline - Date.now()),
      );
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          reject(options.signal?.reason);
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener("abort", abort);
          resolve();
        }, delay);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
    throw new AgentOperationsError(
      408,
      "WAIT_TIMEOUT",
      "Polling timed out; the operation is still tracked by the server",
    );
  }
  /** A tool schema for callers that support JSON Schema function tools. */
  async tool(name: string, version?: number) {
    const operation = await this.operation(name, version);
    return {
      type: "function" as const,
      function: {
        name: "submit_" + name.replaceAll("-", "_"),
        description:
          operation.definition.description ||
          "Submit " + name + " as a durable operation.",
        parameters: operation.definition.inputSchema || { type: "object" },
      },
    };
  }
}
