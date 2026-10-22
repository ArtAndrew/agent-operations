import { randomUUID } from "node:crypto";
import type { Database, Sql } from "./db.js";
import type { Config } from "./config.js";
import {
  AppError,
  OperationSchema,
  type Connector,
  type Identity,
  type Operation,
  type Run,
  type Role,
  type StepRun,
} from "./domain.js";
import { encrypt, decrypt, hash, newToken, validateInput } from "./util.js";
export function validateHeaders(headers: Record<string, string>) {
  if (
    Object.entries(headers).some(
      ([key, value]) =>
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
        /[\r\n]/.test(value) ||
        [
          "host",
          "cookie",
          "content-length",
          "connection",
          "transfer-encoding",
          "proxy-authorization",
          "upgrade",
        ].includes(key.toLowerCase()),
    )
  )
    throw new AppError(400, "INVALID_HEADER", "Unsupported connector header");
}
export class Store {
  connectionBinding(connector: Connector) {
    return {
      id: connector.id,
      name: connector.name,
      baseUrl: connector.base_url,
      kind: connector.kind,
      fingerprint: hash({
        id: connector.id,
        kind: connector.kind,
        baseUrl: connector.base_url,
        headers: connector.headers,
        secret: connector.secret_ciphertext,
        idempotencyHeader: connector.idempotency_header,
      }),
    };
  }
  checkBinding(connector: Connector, expected?: { fingerprint: string }) {
    if (
      expected &&
      this.connectionBinding(connector).fingerprint !== expected.fingerprint
    )
      throw new AppError(
        409,
        "CONNECTION_CHANGED",
        "Connection credentials or configuration changed after the action was prepared",
      );
  }
  constructor(
    public db: Database,
    public config: Config,
  ) {}
  async event(
    tx: Sql,
    workspaceId: string,
    runId: string | null,
    type: string,
    actor: string,
    data: unknown,
  ) {
    data = JSON.parse(JSON.stringify(data ?? null));
    await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      workspaceId,
    ]);
    const last = await tx.query<{ hash: string }>(
      "SELECT hash FROM events WHERE workspace_id=$1 ORDER BY id DESC LIMIT 1",
      [workspaceId],
    );
    const previous = last.rows[0]?.hash || "genesis";
    const digest = hash({ previous, workspaceId, runId, type, actor, data });
    await tx.query(
      "INSERT INTO events(workspace_id,run_id,type,actor,data,previous_hash,hash) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
      [workspaceId, runId, type, actor, JSON.stringify(data), previous, digest],
    );
  }
  async createWorkspace(name: string) {
    return this.db.transaction(async (tx) => {
      const id = randomUUID(),
        keyId = randomUUID(),
        token = newToken();
      await tx.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
        id,
        name,
      ]);
      await tx.query(
        "INSERT INTO api_keys(id,workspace_id,name,token_hash,role) VALUES($1,$2,'Initial administrator',$3,'admin')",
        [keyId, id, hash(token)],
      );
      await this.event(tx, id, null, "workspace.created", "platform", { name });
      return { id, name, token, keyId };
    });
  }
  async authenticate(token: string): Promise<Identity> {
    const result = await this.db.query<{
      workspace_id: string;
      id: string;
      name: string;
      role: Role;
    }>(
      "SELECT id,workspace_id,name,role FROM api_keys WHERE token_hash=$1 AND revoked_at IS NULL",
      [hash(token)],
    );
    const row = result.rows[0];
    if (!row)
      throw new AppError(401, "UNAUTHORIZED", "Invalid or revoked API key");
    return {
      workspaceId: row.workspace_id,
      keyId: row.id,
      name: row.name,
      role: row.role,
    };
  }
  async createKey(identity: Identity, name: string, role: Role) {
    const token = newToken(),
      id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        identity.workspaceId,
      ]);
      await tx.query(
        "INSERT INTO api_keys(id,workspace_id,name,token_hash,role) VALUES($1,$2,$3,$4,$5)",
        [id, identity.workspaceId, name, hash(token), role],
      );
      await this.event(
        tx,
        identity.workspaceId,
        null,
        "key.created",
        identity.keyId,
        { id, name, role },
      );
    });
    return { id, token, name, role };
  }
  async revokeKey(identity: Identity, id: string) {
    if (id === identity.keyId)
      throw new AppError(
        400,
        "SELF_REVOCATION",
        "Use another administrator key to revoke your current key",
      );
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        identity.workspaceId,
      ]);
      const r = await tx.query(
        "UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL RETURNING id",
        [id, identity.workspaceId],
      );
      if (!r.rows.length)
        throw new AppError(404, "NOT_FOUND", "API key not found");
      await this.event(
        tx,
        identity.workspaceId,
        null,
        "key.revoked",
        identity.keyId,
        { id },
      );
    });
  }
  async createConnector(
    identity: Identity,
    input: {
      name: string;
      kind: Connector["kind"];
      baseUrl: string;
      headers?: Record<string, string>;
      secretHeaders?: Record<string, string>;
      idempotencyHeader?: string;
    },
  ) {
    const url = new URL(input.baseUrl);
    if (url.username || url.password || url.hash || url.search)
      throw new AppError(
        400,
        "INVALID_URL",
        "Connector URLs must not contain credentials, query strings or fragments",
      );
    if (!this.config.allowedOrigins.has(url.origin))
      throw new AppError(
        403,
        "ORIGIN_DENIED",
        "The platform administrator must allow this connector origin",
      );
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && this.config.allowPrivateNetwork)
    )
      throw new AppError(
        400,
        "HTTPS_REQUIRED",
        "Connectors require HTTPS outside explicit local development mode",
      );
    validateHeaders({ ...input.headers, ...input.secretHeaders });
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        identity.workspaceId,
      ]);
      await tx.query(
        "INSERT INTO connectors(id,workspace_id,name,kind,base_url,headers,secret_ciphertext,idempotency_header) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
        [
          id,
          identity.workspaceId,
          input.name,
          input.kind,
          url.href,
          JSON.stringify(input.headers || {}),
          input.secretHeaders
            ? encrypt(input.secretHeaders, this.config.masterKey)
            : null,
          input.idempotencyHeader || null,
        ],
      );
      await this.event(
        tx,
        identity.workspaceId,
        null,
        "connector.created",
        identity.keyId,
        { id, name: input.name, kind: input.kind, origin: url.origin },
      );
    });
    return { id, ...input, secretHeaders: undefined };
  }
  async connector(workspaceId: string, id: string): Promise<Connector> {
    const result = await this.db.query<Connector>(
      "SELECT * FROM connectors WHERE workspace_id=$1 AND (id=$2 OR name=$2)",
      [workspaceId, id],
    );
    const row = result.rows[0];
    if (!row)
      throw new AppError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found: " + id,
      );
    return row;
  }
  connectorHeaders(connector: Connector) {
    return {
      ...connector.headers,
      ...(connector.secret_ciphertext
        ? decrypt(connector.secret_ciphertext, this.config.masterKey)
        : {}),
    };
  }
  async register(identity: Identity, raw: unknown) {
    const operation = OperationSchema.parse(raw);
    try {
      validateInput(operation.inputSchema, {});
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "VALIDATION_ERROR") throw e;
    }
    for (const step of operation.steps) {
      if ("connection" in step) {
        const connector = await this.connector(
          identity.workspaceId,
          step.connection,
        );
        const expected = step.kind === "agent" ? "model" : step.kind;
        if (connector.kind !== expected)
          throw new AppError(
            400,
            "CONNECTOR_KIND",
            "Step " + step.id + " requires a " + expected + " connector",
          );
      }
      if (step.kind === "http") validateHeaders(step.request.headers);
      if (step.verify) {
        const connector = await this.connector(
          identity.workspaceId,
          step.verify.connection,
        );
        if (connector.kind !== step.verify.kind)
          throw new AppError(
            400,
            "CONNECTOR_KIND",
            "Verification for " +
              step.id +
              " requires a " +
              step.verify.kind +
              " connector",
          );
        if (step.verify.kind === "http")
          validateHeaders(step.verify.request.headers);
      }
      if (step.kind === "agent") {
        try {
          validateInput(step.outputSchema, {});
        } catch (e) {
          if (!(e instanceof AppError) || e.code !== "VALIDATION_ERROR")
            throw e;
        }
      }
    }
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        identity.workspaceId,
      ]);
      const latest = await tx.query<{ version: number }>(
        "SELECT version FROM operations WHERE workspace_id=$1 AND name=$2 ORDER BY version DESC LIMIT 1",
        [identity.workspaceId, operation.name],
      );
      const id = randomUUID(),
        version = (latest.rows[0]?.version || 0) + 1,
        digest = hash(operation);
      await tx.query(
        "INSERT INTO operations(id,workspace_id,name,version,definition,digest,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
        [
          id,
          identity.workspaceId,
          operation.name,
          version,
          JSON.stringify(operation),
          digest,
          identity.keyId,
        ],
      );
      await this.event(
        tx,
        identity.workspaceId,
        null,
        "operation.published",
        identity.keyId,
        { id, name: operation.name, version, digest },
      );
      return { id, version, digest, definition: operation };
    });
  }
  async operation(workspaceId: string, name: string, version?: number) {
    const result = await this.db.query<{
      id: string;
      version: number;
      name: string;
      definition: Operation;
      digest: string;
    }>(
      "SELECT id,version,name,definition,digest FROM operations WHERE workspace_id=$1 AND name=$2 AND ($3::integer IS NULL OR version=$3) ORDER BY version DESC LIMIT 1",
      [workspaceId, name, version ?? null],
    );
    const op = result.rows[0];
    if (!op) throw new AppError(404, "NOT_FOUND", "Operation not found");
    return op;
  }
  async submit(
    identity: Identity,
    name: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
    version?: number,
  ) {
    return this.db.transaction(async (tx) => {
      const workspace = await tx.query<{ max_runs_per_day: number }>(
        "SELECT * FROM workspaces WHERE id=$1 FOR UPDATE",
        [identity.workspaceId],
      );
      const old = await tx.query<Run>(
        "SELECT * FROM runs WHERE workspace_id=$1 AND idempotency_key=$2",
        [identity.workspaceId, idempotencyKey],
      );
      if (old.rows[0]) {
        const previous = old.rows[0];
        if (
          previous.operation_name !== name ||
          (version !== undefined && previous.version !== version) ||
          hash(previous.input) !== hash(input)
        )
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was used with a different operation, version or input",
          );
        return { run: previous, replayed: true };
      }
      const op = (
        await tx.query<{ id: string; version: number; definition: Operation }>(
          "SELECT id,version,definition FROM operations WHERE workspace_id=$1 AND name=$2 AND ($3::integer IS NULL OR version=$3) ORDER BY version DESC LIMIT 1",
          [identity.workspaceId, name, version ?? null],
        )
      ).rows[0];
      if (!op) throw new AppError(404, "NOT_FOUND", "Operation not found");
      validateInput(op.definition.inputSchema, input);
      const inputHash = hash({ name, version: op.version, input });
      const count = await tx.query<{ count: string }>(
        "SELECT count(*) FROM runs WHERE workspace_id=$1 AND created_at>=date_trunc('day',now())",
        [identity.workspaceId],
      );
      if (Number(count.rows[0]?.count) >= workspace.rows[0]!.max_runs_per_day)
        throw new AppError(429, "DAILY_QUOTA", "Daily operation quota reached");
      const id = randomUUID();
      const run = await tx.query<Run>(
        "INSERT INTO runs(id,workspace_id,operation_id,operation_name,version,input,input_hash,status,created_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'QUEUED',$8,$9) RETURNING *",
        [
          id,
          identity.workspaceId,
          op.id,
          name,
          op.version,
          JSON.stringify(input),
          inputHash,
          identity.keyId,
          idempotencyKey,
        ],
      );
      for (const step of op.definition.steps)
        await tx.query(
          "INSERT INTO step_runs(id,run_id,step_id) VALUES($1,$2,$3)",
          [randomUUID(), id, step.id],
        );
      await this.event(
        tx,
        identity.workspaceId,
        id,
        "run.queued",
        identity.keyId,
        { operation: name, version: op.version },
      );
      return { run: run.rows[0]!, replayed: false };
    });
  }
  async run(workspaceId: string, id: string) {
    const result = await this.db.query<Run>(
      "SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    const run = result.rows[0];
    if (!run) throw new AppError(404, "NOT_FOUND", "Run not found");
    return run;
  }
  async detail(workspaceId: string, id: string) {
    const run = await this.run(workspaceId, id);
    const definition = await this.operation(
      workspaceId,
      run.operation_name,
      run.version,
    );
    const [steps, events, attempts, artifacts, approvals] = await Promise.all([
      this.db.query<StepRun>(
        "SELECT * FROM step_runs WHERE run_id=$1 ORDER BY started_at NULLS LAST,step_id",
        [id],
      ),
      this.db.query(
        "SELECT * FROM events WHERE run_id=$1 AND workspace_id=$2 ORDER BY id",
        [id, workspaceId],
      ),
      this.db.query(
        "SELECT * FROM attempts WHERE run_id=$1 AND workspace_id=$2 ORDER BY created_at",
        [id, workspaceId],
      ),
      this.db.query(
        "SELECT id,name,content_type,size_bytes,sha256,created_at,step_id FROM artifacts WHERE run_id=$1 AND workspace_id=$2 ORDER BY created_at",
        [id, workspaceId],
      ),
      this.db.query(
        "SELECT * FROM approvals WHERE run_id=$1 AND workspace_id=$2 ORDER BY created_at",
        [id, workspaceId],
      ),
    ]);
    return {
      run,
      steps: definition.definition.steps.map((step) =>
        steps.rows.find((row) => row.step_id === step.id)!,
      ),
      events: events.rows,
      attempts: attempts.rows,
      artifacts: artifacts.rows,
      approvals: approvals.rows,
    };
  }
  async decide(
    identity: Identity,
    approvalId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        identity.workspaceId,
      ]);
      const rows = await tx.query<{
        run_id: string;
        step_id: string;
        digest: string;
        status: string;
        requested_by: string;
      }>("SELECT * FROM approvals WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [
        approvalId,
        identity.workspaceId,
      ]);
      const approval = rows.rows[0];
      if (!approval) throw new AppError(404, "NOT_FOUND", "Approval not found");
      if (approval.status !== "PENDING")
        throw new AppError(
          409,
          "ALREADY_DECIDED",
          "Approval has already been decided",
        );
      const workspace = await tx.query<{ two_person_approval: boolean }>(
        "SELECT two_person_approval FROM workspaces WHERE id=$1",
        [identity.workspaceId],
      );
      if (
        workspace.rows[0]?.two_person_approval &&
        identity.keyId === approval.requested_by
      )
        throw new AppError(
          403,
          "SEPARATION_OF_DUTIES",
          "A different API identity must approve this operation",
        );
      const step = await tx.query<StepRun>(
        "SELECT * FROM step_runs WHERE run_id=$1 AND step_id=$2",
        [approval.run_id, approval.step_id],
      );
      const run = await tx.query<Run>(
        "SELECT * FROM runs WHERE id=$1 FOR UPDATE",
        [approval.run_id],
      );
      if (
        run.rows[0]?.status !== "WAITING_APPROVAL" ||
        step.rows[0]?.digest !== approval.digest
      )
        throw new AppError(
          409,
          "STALE_APPROVAL",
          "The approval no longer matches the pending action",
        );
      await tx.query(
        "UPDATE approvals SET status=$1,decided_by=$2,reason=$3,decided_at=now() WHERE id=$4",
        [decision, identity.keyId, reason, approvalId],
      );
      await tx.query(
        "UPDATE runs SET status=$1,error=$2,available_at=now(),updated_at=now() WHERE id=$3",
        [
          decision === "APPROVED" ? "QUEUED" : "FAILED",
          decision === "REJECTED" ? "Operation rejected by reviewer" : null,
          approval.run_id,
        ],
      );
      if (decision === "REJECTED")
        await tx.query(
          "UPDATE step_runs SET status='FAILED',error='Rejected by reviewer',finished_at=now() WHERE id=$1",
          [step.rows[0]!.id],
        );
      await this.event(
        tx,
        identity.workspaceId,
        approval.run_id,
        "approval." + decision.toLowerCase(),
        identity.keyId,
        { approvalId, digest: approval.digest, reason },
      );
      return { status: decision };
    });
  }
  async cancel(identity: Identity, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        identity.workspaceId,
      ]);
      const result = await tx.query<Run>(
        "SELECT * FROM runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        [id, identity.workspaceId],
      );
      const run = result.rows[0];
      if (!run) throw new AppError(404, "NOT_FOUND", "Run not found");
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.status))
        throw new AppError(409, "TERMINAL_RUN", "Run has already finished");
      if (run.status === "NEEDS_ATTENTION")
        throw new AppError(
          409,
          "UNRESOLVED_EFFECT",
          "Reconcile the uncertain action before cancelling",
        );
      if (
        run.lease_token &&
        run.lease_until &&
        new Date(run.lease_until) > new Date()
      ) {
        await tx.query(
          "UPDATE runs SET cancel_requested=true,updated_at=now() WHERE id=$1",
          [id],
        );
      } else {
        const dispatched = await tx.query(
          "SELECT id FROM step_runs WHERE run_id=$1 AND status IN('DISPATCHED','VERIFYING','UNKNOWN')",
          [id],
        );
        if (dispatched.rows.length)
          throw new AppError(
            409,
            "UNRESOLVED_EFFECT",
            "Reconcile the in-flight action before cancelling",
          );
        await tx.query(
          "UPDATE runs SET status='CANCELLED',error=$2,updated_at=now(),cancel_requested=true WHERE id=$1",
          [id, reason],
        );
        await tx.query(
          "UPDATE approvals SET status='CANCELLED',reason=$2,decided_at=now() WHERE run_id=$1 AND status='PENDING'",
          [id, reason],
        );
      }
      await this.event(
        tx,
        identity.workspaceId,
        id,
        "run.cancel_requested",
        identity.keyId,
        { reason },
      );
    });
  }
  async reconcile(identity: Identity, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        identity.workspaceId,
      ]);
      const result = await tx.query<Run>(
        "SELECT * FROM runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        [id, identity.workspaceId],
      );
      const run = result.rows[0];
      if (!run) throw new AppError(404, "NOT_FOUND", "Run not found");
      if (run.status !== "NEEDS_ATTENTION")
        throw new AppError(
          409,
          "NOT_RECONCILABLE",
          "Only runs needing attention can be reconciled",
        );
      await tx.query(
        "UPDATE runs SET status='QUEUED',lease_token=NULL,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
      await this.event(
        tx,
        identity.workspaceId,
        id,
        "run.reconciliation_requested",
        identity.keyId,
        { reason },
      );
    });
  }
}
