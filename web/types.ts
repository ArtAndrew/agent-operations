import type { Operation, Run, StepRun, Role } from "../src/domain.js";
export type { Operation, Run, StepRun, Role };
export interface Workspace {
  id: string;
  name: string;
  max_runs_per_day: number;
  max_concurrent_runs: number;
  two_person_approval: boolean;
}
export interface Me {
  platform?: boolean;
  workspaceId: string;
  keyId: string;
  name: string;
  role: Role;
  workspace: Workspace;
  allowedOrigins: string[];
}
export interface PublishedOperation {
  id: string;
  name: string;
  version: number;
  definition: Operation;
  digest: string;
  created_at: string;
}
export interface Connector {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  headers: Record<string, string>;
  has_secrets: boolean;
  idempotency_header: string | null;
}
export interface Approval {
  id: string;
  run_id: string;
  step_id: string;
  digest: string;
  status: string;
  requested_by: string;
  reason: string;
  operation_name: string;
  resolved: unknown;
  created_at: string;
}
export interface Event {
  id: string;
  run_id: string | null;
  type: string;
  actor: string;
  data: unknown;
  hash: string;
  created_at: string;
}
export interface Attempt {
  id: string;
  step_id: string;
  phase: string;
  status: string;
  duration_ms: number;
  usage: {
    httpRequests: number;
    browserMs: number;
    inputTokens: number;
    outputTokens: number;
  };
  error: string | null;
}
export interface Artifact {
  id: string;
  name: string;
  step_id: string;
  size_bytes: number;
  content_type: string;
  sha256: string;
}
export interface Detail {
  run: Run;
  steps: StepRun[];
  events: Event[];
  attempts: Attempt[];
  artifacts: Artifact[];
  approvals: Approval[];
}
export interface Key {
  id: string;
  name: string;
  role: Role;
  revoked_at: string | null;
  created_at: string;
}
export interface Usage {
  runs: Array<{ status: string; count: number }>;
  usage: {
    attempts: number;
    duration_ms: string;
    http_requests: string;
    browser_ms: string;
    input_tokens: string;
    output_tokens: string;
  };
}
