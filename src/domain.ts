import { z } from "zod";
export const JsonSchema = z.record(z.string(), z.unknown());
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const RequestSchema = z.object({
  method: z
    .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
    .default("GET"),
  path: z.string().min(1).max(4000),
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.string()).default({}),
});
export const BrowserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), path: z.string().min(1) }),
  z.object({
    action: z.literal("fill"),
    selector: z.string().min(1),
    value: z.string(),
  }),
  z.object({ action: z.literal("click"), selector: z.string().min(1) }),
  z.object({
    action: z.literal("select"),
    selector: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    action: z.literal("press"),
    selector: z.string().min(1),
    key: z.string().min(1),
  }),
  z.object({
    action: z.literal("wait"),
    selector: z.string().min(1),
    state: z.enum(["visible", "hidden", "attached"]).default("visible"),
  }),
]);
export const AssertionSchema = z.object({
  path: z.string(),
  operator: z.enum(["equals", "exists", "contains", "greaterThan", "lessThan"]),
  value: z.unknown().optional(),
});
export const VerificationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http"),
    connection: z.string(),
    request: RequestSchema,
    assertions: z.array(AssertionSchema).min(1),
    absentStatuses: z.array(z.number().int().min(400).max(499)).default([404]),
  }),
  z.object({
    kind: z.literal("browser"),
    connection: z.string(),
    path: z.string(),
    extract: z
      .record(z.string(), z.string())
      .refine((v) => Object.keys(v).length > 0),
    assertions: z.array(AssertionSchema).min(1),
  }),
]);
const common = {
  id: identifier,
  title: z.string().max(160).optional(),
  effect: z.enum(["read", "write"]).default("read"),
  businessKey: z.string().optional(),
  approval: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(120000).default(30000),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(3),
      delayMs: z.number().int().min(100).max(3600000).default(1000),
    })
    .default({ maxAttempts: 3, delayMs: 1000 }),
  verify: VerificationSchema.optional(),
};
export const StepSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("http"),
    connection: z.string(),
    request: RequestSchema,
  }),
  z.object({
    ...common,
    kind: z.literal("browser"),
    connection: z.string(),
    actions: z.array(BrowserActionSchema).min(1).max(40),
    extract: z.record(z.string(), z.string()).default({}),
    screenshot: z.boolean().default(true),
  }),
  z.object({
    ...common,
    kind: z.literal("transform"),
    value: z.unknown(),
    assertions: z.array(AssertionSchema).default([]),
  }),
  z.object({
    ...common,
    kind: z.literal("agent"),
    connection: z.string(),
    model: z.string().min(1),
    instructions: z.string().max(30000),
    prompt: z.string().max(100000),
    outputSchema: JsonSchema,
    maxTokens: z.number().int().min(1).max(32000).default(2000),
  }),
]);
export const OperationSchema = z
  .object({
    name: identifier,
    description: z.string().max(4000).default(""),
    inputSchema: JsonSchema.default({ type: "object" }),
    steps: z.array(StepSchema).min(1).max(100),
  })
  .superRefine((op, ctx) => {
    const ids = new Set<string>();
    for (const [i, step] of op.steps.entries()) {
      const issue = (message: string) =>
        ctx.addIssue({ code: "custom", message, path: ["steps", i] });
      if (ids.has(step.id)) issue("Step identifiers must be unique");
      ids.add(step.id);
      if (step.effect === "write" && (!step.businessKey || !step.verify))
        issue("Write steps require a stable businessKey and verification");
      if (
        (step.kind === "agent" || step.kind === "transform") &&
        step.effect === "write"
      )
        issue("Agent and transform steps cannot perform external writes");
      if (
        step.kind === "http" &&
        !["GET", "HEAD"].includes(step.request.method) &&
        step.effect !== "write"
      )
        issue("Mutating HTTP methods must be classified as write");
      if (
        step.kind === "http" &&
        ["GET", "HEAD"].includes(step.request.method) &&
        step.request.body !== undefined
      )
        issue("GET and HEAD cannot contain a body");
      if (
        step.kind === "browser" &&
        step.actions.some((a) =>
          ["click", "fill", "select", "press"].includes(a.action),
        ) &&
        step.effect !== "write"
      )
        issue("Interactive browser recipes must be classified as write");
      if (
        step.verify?.kind === "http" &&
        !["GET", "HEAD"].includes(step.verify.request.method)
      )
        issue("Verification must be read-only");
    }
  });
export type Operation = z.infer<typeof OperationSchema>;
export type Step = Operation["steps"][number];
export interface ConnectionBinding {
  id: string;
  name: string;
  baseUrl: string;
  kind: string;
  fingerprint: string;
}
export type ResolvedStep = Step & {
  connections?: {
    action?: ConnectionBinding;
    verification?: ConnectionBinding;
  };
};
export type Verification = z.infer<typeof VerificationSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type HttpRequest = z.infer<typeof RequestSchema>;
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export type RunStatus =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "RETRYING"
  | "NEEDS_ATTENTION"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";
export type StepStatus =
  | "PENDING"
  | "AWAITING_APPROVAL"
  | "DISPATCHED"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN";
export type Role = "admin" | "operator" | "reviewer" | "viewer";
export interface Identity {
  workspaceId: string;
  keyId: string;
  name: string;
  role: Role;
}
export interface Connector {
  id: string;
  workspace_id: string;
  name: string;
  kind: "http" | "browser" | "model";
  base_url: string;
  headers: Record<string, string>;
  secret_ciphertext: string | null;
  idempotency_header: string | null;
  created_at: string;
}
export interface Run {
  id: string;
  workspace_id: string;
  operation_id: string;
  operation_name: string;
  version: number;
  input: Record<string, unknown>;
  input_hash: string;
  status: RunStatus;
  next_step: number;
  outputs: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  lease_token: string | null;
  lease_until: string | null;
  available_at: string;
  error: string | null;
  cancel_requested: boolean;
  idempotency_key: string;
}
export interface StepRun {
  id: string;
  run_id: string;
  step_id: string;
  status: StepStatus;
  attempts: number;
  resolved: ResolvedStep | null;
  digest: string | null;
  action_key: string | null;
  output: unknown;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}
export interface ExecutionResult {
  output: unknown;
  usage: Usage;
  artifacts?: Array<{ name: string; content: Buffer; contentType: string }>;
}
export interface Usage {
  httpRequests: number;
  browserMs: number;
  inputTokens: number;
  outputTokens: number;
}
export const emptyUsage = (): Usage => ({
  httpRequests: 0,
  browserMs: 0,
  inputTokens: 0,
  outputTokens: 0,
});
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export class ExecutionError extends Error {
  constructor(
    message: string,
    public ambiguous = false,
    public retryable = false,
    public usage: Usage = emptyUsage(),
  ) {
    super(message);
  }
}
export class LeaseLostError extends Error {}
