import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Sql } from "./db.js";
import { Executors, type VerificationResult } from "./executors.js";
import { Artifacts } from "./artifacts.js";
import {
  AppError,
  ExecutionError,
  LeaseLostError,
  emptyUsage,
  type Run,
  type StepRun,
  type Step,
  type ResolvedStep,
  type Operation,
  type Usage,
} from "./domain.js";
import { hash, resolve, safeError, sleep } from "./util.js";
export class Engine {
  readonly executors: Executors;
  readonly artifacts: Artifacts;
  private stopping = false;
  private loops: Promise<void>[] = [];
  private controllers = new Set<AbortController>();
  constructor(
    public store: Store,
    executors?: Executors,
  ) {
    this.executors = executors || new Executors(store);
    this.artifacts = new Artifacts(store.db, store.config);
  }
  async claim(): Promise<Run | undefined> {
    return this.store.db.transaction(async (tx) => {
      const ready =
        "r.status IN ('QUEUED','RETRYING','RUNNING') AND r.available_at<=now() AND (r.lease_until IS NULL OR r.lease_until<now())";
      const workspace = await tx.query<{
        id: string;
        max_concurrent_runs: number;
      }>(
        `SELECT w.id,w.max_concurrent_runs FROM workspaces w WHERE EXISTS(SELECT 1 FROM runs r WHERE r.workspace_id=w.id AND ${ready}) AND (SELECT count(*) FROM runs a WHERE a.workspace_id=w.id AND a.lease_until>now())<w.max_concurrent_runs ORDER BY w.last_claimed_at NULLS FIRST,w.created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const w = workspace.rows[0];
      if (!w) return;
      const active = await tx.query<{ count: string }>(
        "SELECT count(*) FROM runs WHERE workspace_id=$1 AND lease_until>now()",
        [w.id],
      );
      if (Number(active.rows[0]?.count) >= w.max_concurrent_runs) return;
      const candidates = await tx.query<Run>(
        `SELECT r.* FROM runs r WHERE workspace_id=$1 AND ${ready} ORDER BY r.available_at,r.created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [w.id],
      );
      const candidate = candidates.rows[0];
      if (!candidate) return;
      await tx.query(
        "UPDATE workspaces SET last_claimed_at=clock_timestamp() WHERE id=$1",
        [w.id],
      );
      const row = await tx.query<Run>(
        "UPDATE runs SET status='RUNNING',lease_token=$2,lease_until=now()+($3::integer*interval '1 millisecond'),updated_at=now() WHERE id=$1 RETURNING *",
        [candidate.id, randomUUID(), this.store.config.leaseMs],
      );
      return row.rows[0];
    });
  }
  private async fenced<T>(
    run: Run,
    fn: (tx: Sql, current: Run) => Promise<T>,
  ): Promise<T> {
    return this.store.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        run.workspace_id,
      ]);
      const r = await tx.query<Run & { lease_valid: boolean }>(
        "SELECT *,lease_until>clock_timestamp() AS lease_valid FROM runs WHERE id=$1 FOR UPDATE",
        [run.id],
      );
      const current = r.rows[0];
      if (
        !current ||
        current.lease_token !== run.lease_token ||
        !current.lease_valid
      )
        throw new LeaseLostError("Worker lease lost");
      return fn(tx, current);
    });
  }
  private async heartbeat(run: Run, controller: AbortController) {
    try {
      const r = await this.store.db.query(
        "UPDATE runs SET lease_until=now()+($3::integer*interval '1 millisecond') WHERE id=$1 AND lease_token=$2 AND lease_until>now() RETURNING id",
        [run.id, run.lease_token, this.store.config.leaseMs],
      );
      if (!r.rows.length) controller.abort(new LeaseLostError());
    } catch {
      controller.abort(new LeaseLostError());
    }
  }
  private async attempt(
    run: Run,
    step: ResolvedStep,
    phase: string,
    start: number,
    status: string,
    usage: Usage,
    error?: string,
  ) {
    await this.store.db.query(
      "INSERT INTO attempts(id,workspace_id,run_id,step_id,phase,status,duration_ms,usage,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
      [
        randomUUID(),
        run.workspace_id,
        run.id,
        step.id,
        phase,
        status,
        Date.now() - start,
        JSON.stringify(usage),
        error || null,
      ],
    );
  }
  private async release(
    run: Run,
    status: string,
    error: string | null,
    delay = 0,
  ) {
    await this.fenced(run, async (tx) => {
      await tx.query(
        "UPDATE runs SET status=$2,error=$3,available_at=now()+($4::integer*interval '1 millisecond'),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [run.id, status, error, delay],
      );
      await this.store.event(
        tx,
        run.workspace_id,
        run.id,
        "run." + status.toLowerCase(),
        "worker",
        { error },
      );
    });
  }
  private async complete(
    run: Run,
    step: Step,
    output: unknown,
    actionKey: string | undefined,
    receipt: unknown,
  ) {
    await this.fenced(run, async (tx, current) => {
      if (actionKey)
        await tx.query(
          "UPDATE action_ledger SET status='SUCCEEDED',output=$3::jsonb,receipt=$4::jsonb,updated_at=now() WHERE workspace_id=$1 AND action_key=$2",
          [
            run.workspace_id,
            actionKey,
            JSON.stringify(output ?? null),
            JSON.stringify(receipt),
          ],
        );
      await tx.query(
        "UPDATE step_runs SET status='SUCCEEDED',output=$3::jsonb,error=NULL,finished_at=now() WHERE run_id=$1 AND step_id=$2",
        [run.id, step.id, JSON.stringify(output ?? null)],
      );
      const op = await tx.query<{ definition: Operation }>(
        "SELECT definition FROM operations WHERE id=$1",
        [run.operation_id],
      );
      const done = current.next_step + 1 >= op.rows[0]!.definition.steps.length;
      const status = current.cancel_requested
        ? "CANCELLED"
        : done
          ? "SUCCEEDED"
          : "QUEUED";
      await tx.query(
        "UPDATE runs SET status=$2,next_step=next_step+1,outputs=$3::jsonb,error=NULL,lease_token=NULL,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1",
        [
          run.id,
          status,
          JSON.stringify({ ...current.outputs, [step.id]: output }),
        ],
      );
      await this.store.event(
        tx,
        run.workspace_id,
        run.id,
        "step.succeeded",
        "worker",
        { stepId: step.id, receipt, outputHash: hash(output) },
      );
      if (done || current.cancel_requested)
        await this.store.event(
          tx,
          run.workspace_id,
          run.id,
          "run." + status.toLowerCase(),
          "worker",
          {},
        );
    });
  }
  private async attention(
    run: Run,
    step: Step,
    actionKey: string | undefined,
    error: string,
  ) {
    await this.fenced(run, async (tx) => {
      await tx.query(
        "UPDATE step_runs SET status='UNKNOWN',error=$3 WHERE run_id=$1 AND step_id=$2",
        [run.id, step.id, error],
      );
      if (actionKey)
        await tx.query(
          "UPDATE action_ledger SET status='UNKNOWN',updated_at=now() WHERE workspace_id=$1 AND action_key=$2 AND status<>'SUCCEEDED'",
          [run.workspace_id, actionKey],
        );
      await tx.query(
        "UPDATE runs SET status='NEEDS_ATTENTION',error=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [run.id, error],
      );
      await this.store.event(
        tx,
        run.workspace_id,
        run.id,
        "step.uncertain",
        "worker",
        { stepId: step.id, reason: error },
      );
    });
  }
  private async verify(
    run: Run,
    step: ResolvedStep,
    output: unknown,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    if (!step.verify)
      return { status: "confirmed", output, usage: emptyUsage() };
    const start = Date.now();
    let result: VerificationResult;
    try {
      const verifier = resolve(step.verify, {
        input: run.input,
        steps: { ...run.outputs, [step.id]: output },
        output,
      });
      result = await this.executors.verify(
        run.workspace_id,
        verifier,
        signal,
        step.connections?.verification,
      );
    } catch (e) {
      result = {
        status: "unknown",
        reason:
          e instanceof AppError
            ? e.message
            : "Verification could not determine the external result",
        usage: e instanceof ExecutionError ? e.usage : emptyUsage(),
      };
    }
    await this.attempt(
      run,
      step,
      "verify",
      start,
      result.status,
      result.usage,
      result.reason,
    );
    return result;
  }
  async tick(): Promise<boolean> {
    const run = await this.claim();
    if (!run) return false;
    await this.process(run);
    return true;
  }
  async process(run: Run) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const heartbeat = setInterval(
      () => void this.heartbeat(run, controller),
      Math.max(100, this.store.config.leaseMs / 3),
    );
    heartbeat.unref();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let activeStep: Step | undefined,
      actionKey: string | undefined,
      mayHaveDispatched = false;
    try {
      const op = await this.store.db.query<{ definition: Operation }>(
        "SELECT definition FROM operations WHERE id=$1",
        [run.operation_id],
      );
      const definition = op.rows[0]!.definition,
        original = definition.steps[run.next_step];
      if (!original) {
        await this.release(
          run,
          run.cancel_requested ? "CANCELLED" : "SUCCEEDED",
          null,
        );
        return;
      }
      const sr = (
        await this.store.db.query<StepRun>(
          "SELECT * FROM step_runs WHERE run_id=$1 AND step_id=$2",
          [run.id, original.id],
        )
      ).rows[0]!;
      const { verify, ...executable } = original;
      const resolved: ResolvedStep = JSON.parse(
        JSON.stringify(
          sr.resolved || {
            ...resolve(executable, { input: run.input, steps: run.outputs }),
            verify,
          },
        ),
      );
      if (!sr.resolved) {
        resolved.connections = {};
        if ("connection" in resolved)
          resolved.connections.action = this.store.connectionBinding(
            await this.store.connector(run.workspace_id, resolved.connection),
          );
        if (resolved.verify)
          resolved.connections.verification = this.store.connectionBinding(
            await this.store.connector(
              run.workspace_id,
              resolved.verify.connection,
            ),
          );
      }
      activeStep = resolved;
      const step = resolved,
        digest = hash(step);
      if (step.effect === "write")
        actionKey = hash({
          workspace: run.workspace_id,
          operation: run.operation_name,
          step: step.id,
          businessKey: String(step.businessKey),
        });
      timeout = setTimeout(
        () => controller.abort(new Error("Step timeout")),
        step.timeoutMs,
      );
      timeout.unref();
      if (
        run.cancel_requested &&
        !["DISPATCHED", "VERIFYING", "UNKNOWN"].includes(sr.status)
      ) {
        await this.release(run, "CANCELLED", "Cancelled before dispatch");
        return;
      }
      const prepared = await this.fenced(run, async (tx, current) => {
        if (
          current.cancel_requested &&
          !["DISPATCHED", "VERIFYING", "UNKNOWN"].includes(sr.status)
        )
          return "cancelled";
        await tx.query(
          "UPDATE step_runs SET resolved=$3::jsonb,digest=$4,action_key=$5 WHERE run_id=$1 AND step_id=$2",
          [run.id, step.id, JSON.stringify(step), digest, actionKey || null],
        );
        if (step.approval) {
          const approval = await tx.query<{ status: string; digest: string }>(
            "SELECT status,digest FROM approvals WHERE run_id=$1 AND step_id=$2 AND digest=$3",
            [run.id, step.id, digest],
          );
          if (!approval.rows[0]) {
            await tx.query(
              "INSERT INTO approvals(id,workspace_id,run_id,step_id,digest,requested_by) VALUES($1,$2,$3,$4,$5,$6)",
              [
                randomUUID(),
                run.workspace_id,
                run.id,
                step.id,
                digest,
                run.created_by,
              ],
            );
            await tx.query(
              "UPDATE step_runs SET status='AWAITING_APPROVAL' WHERE run_id=$1 AND step_id=$2",
              [run.id, step.id],
            );
            await tx.query(
              "UPDATE runs SET status='WAITING_APPROVAL',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
              [run.id],
            );
            await this.store.event(
              tx,
              run.workspace_id,
              run.id,
              "approval.requested",
              "worker",
              { stepId: step.id, digest },
            );
            return "waiting";
          }
          if (approval.rows[0].status !== "APPROVED")
            throw new AppError(
              409,
              "APPROVAL_REQUIRED",
              "Action approval is not valid",
            );
        }
        return "ready";
      });
      if (prepared === "waiting") return;
      if (prepared === "cancelled") {
        await this.release(run, "CANCELLED", "Cancelled before dispatch");
        return;
      }
      let recover = ["DISPATCHED", "VERIFYING", "UNKNOWN"].includes(sr.status);
      mayHaveDispatched = recover && step.effect === "write";
      if (!recover) {
        if ("connection" in step)
          this.store.checkBinding(
            await this.store.connector(run.workspace_id, step.connection),
            step.connections?.action,
          );
        if (step.verify)
          this.store.checkBinding(
            await this.store.connector(
              run.workspace_id,
              step.verify.connection,
            ),
            step.connections?.verification,
          );
      }
      if (actionKey) {
        const ledger = await this.fenced(run, async (tx) => {
          await tx.query(
            "INSERT INTO action_ledger(workspace_id,action_key,digest,status,owner_run_id) VALUES($1,$2,$3,'PREPARED',$4) ON CONFLICT DO NOTHING",
            [run.workspace_id, actionKey, digest, run.id],
          );
          const row = (
            await tx.query<{
              digest: string;
              status: string;
              owner_run_id: string;
              output: unknown;
              receipt: unknown;
            }>(
              "SELECT * FROM action_ledger WHERE workspace_id=$1 AND action_key=$2 FOR UPDATE",
              [run.workspace_id, actionKey],
            )
          ).rows[0]!;
          let busy = false;
          if (
            row.owner_run_id !== run.id &&
            row.status !== "SUCCEEDED" &&
            row.status !== "FAILED"
          ) {
            const owner = (
              await tx.query<{ active: boolean }>(
                "SELECT lease_until>clock_timestamp() AS active FROM runs WHERE id=$1",
                [row.owner_run_id],
              )
            ).rows[0]!;
            busy = !!owner.active;
            if (!busy)
              await tx.query(
                "UPDATE action_ledger SET owner_run_id=$3,updated_at=now() WHERE workspace_id=$1 AND action_key=$2",
                [run.workspace_id, actionKey, run.id],
              );
          }
          return { ...row, busy };
        });
        if (ledger.digest !== digest)
          throw new AppError(
            409,
            "ACTION_CONFLICT",
            "Business key already belongs to a different action payload",
          );
        if (ledger.status === "SUCCEEDED") {
          await this.complete(run, step, ledger.output, undefined, {
            source: "ledger",
            actionKey,
          });
          return;
        }
        if (ledger.busy) {
          await this.release(
            run,
            "RETRYING",
            "Waiting for the existing action owner",
            1000,
          );
          return;
        }
        if (["DISPATCHED", "UNKNOWN"].includes(ledger.status)) recover = true;
        if (ledger.status === "FAILED")
          throw new AppError(
            409,
            "ACTION_PREVIOUSLY_FAILED",
            "This action was manually closed as failed; review the prior operation",
          );
      }
      if (recover && step.effect === "write") {
        mayHaveDispatched = true;
        const verification = await this.verify(
          run,
          step,
          sr.output,
          controller.signal,
        );
        if (verification.status === "confirmed") {
          await this.complete(run, step, verification.output, actionKey, {
            source: "verification",
            recovered: true,
          });
          return;
        }
        await this.attention(
          run,
          step,
          actionKey,
          verification.reason ||
            "The previous dispatch has no confirmed external result",
        );
        return;
      }
      await this.fenced(run, async (tx, current) => {
        if (current.cancel_requested)
          throw new AppError(409, "CANCELLED", "Cancelled before dispatch");
        if (actionKey) {
          const claim = await tx.query(
            "UPDATE action_ledger SET status='DISPATCHED',updated_at=now() WHERE workspace_id=$1 AND action_key=$2 AND owner_run_id=$3 AND status='PREPARED' RETURNING action_key",
            [run.workspace_id, actionKey, run.id],
          );
          if (!claim.rows.length)
            throw new LeaseLostError("Business action ownership changed");
        }
        await tx.query(
          "UPDATE step_runs SET status='DISPATCHED',attempts=attempts+1,started_at=COALESCE(started_at,now()),error=NULL WHERE run_id=$1 AND step_id=$2",
          [run.id, step.id],
        );
        await this.store.event(
          tx,
          run.workspace_id,
          run.id,
          "step.dispatched",
          "worker",
          { stepId: step.id, digest, actionKey, attempt: sr.attempts + 1 },
        );
      });
      mayHaveDispatched = step.effect === "write";
      let output: unknown;
      const start = Date.now();
      try {
        const result = await this.executors.execute(
          run.workspace_id,
          step,
          actionKey,
          controller.signal,
        );
        output = result.output;
        await this.attempt(
          run,
          step,
          "execute",
          start,
          "SUCCEEDED",
          result.usage,
        );
        for (const artifact of result.artifacts || [])
          await this.artifacts.save(
            run.workspace_id,
            run.id,
            step.id,
            artifact,
          );
      } catch (e) {
        await this.attempt(
          run,
          step,
          "execute",
          start,
          "FAILED",
          e instanceof ExecutionError ? e.usage : emptyUsage(),
          e instanceof ExecutionError
            ? e.message
            : "Executor rejected the operation",
        );
        if (step.effect === "write") {
          // Use a fresh bounded read-only verification window after a dispatch timeout.
          const verification = await this.verify(
            run,
            step,
            null,
            AbortSignal.timeout(Math.min(step.timeoutMs, 30000)),
          );
          if (verification.status === "confirmed") {
            await this.complete(run, step, verification.output, actionKey, {
              source: "verification",
              recovered: true,
            });
            return;
          }
          const connector =
            "connection" in step
              ? await this.store.connector(run.workspace_id, step.connection)
              : undefined;
          if (
            verification.status === "absent" &&
            step.kind === "http" &&
            connector?.idempotency_header &&
            sr.attempts + 1 < step.retry.maxAttempts &&
            e instanceof ExecutionError &&
            e.retryable
          ) {
            await this.fenced(run, async (tx) => {
              await tx.query(
                "UPDATE step_runs SET status='PENDING',error=$3 WHERE run_id=$1 AND step_id=$2",
                [run.id, step.id, e.message],
              );
              await tx.query(
                "UPDATE action_ledger SET status='PREPARED',updated_at=now() WHERE workspace_id=$1 AND action_key=$2",
                [run.workspace_id, actionKey],
              );
            });
            await this.release(
              run,
              "RETRYING",
              "Retrying with the same provider idempotency key",
              step.retry.delayMs * 2 ** sr.attempts,
            );
            return;
          }
          await this.attention(
            run,
            step,
            actionKey,
            verification.reason ||
              "Dispatch may have completed; no automatic replay is safe",
          );
          return;
        }
        if (
          e instanceof ExecutionError &&
          e.retryable &&
          sr.attempts + 1 < step.retry.maxAttempts
        ) {
          await this.release(
            run,
            "RETRYING",
            e.message,
            step.retry.delayMs * 2 ** sr.attempts,
          );
          return;
        }
        throw e;
      }
      await this.fenced(run, async (tx) => {
        await tx.query(
          "UPDATE step_runs SET status='VERIFYING',output=$3::jsonb WHERE run_id=$1 AND step_id=$2",
          [run.id, step.id, JSON.stringify(output ?? null)],
        );
      });
      const verification = await this.verify(
        run,
        step,
        output,
        controller.signal,
      );
      if (verification.status !== "confirmed") {
        if (step.effect === "write")
          await this.attention(
            run,
            step,
            actionKey,
            verification.reason || "Result verification failed",
          );
        else
          throw new ExecutionError(
            verification.reason || "Result verification failed",
          );
        return;
      }
      await this.complete(
        run,
        step,
        step.verify ? verification.output : output,
        actionKey,
        { source: step.verify ? "verification" : "executor" },
      );
    } catch (e) {
      if (e instanceof LeaseLostError) return;
      const error =
        e instanceof AppError || e instanceof ExecutionError
          ? e.message
          : safeError(e);
      try {
        if (mayHaveDispatched && activeStep) {
          await this.attention(
            run,
            activeStep,
            actionKey,
            "Execution stopped after dispatch; reconcile the external result",
          );
          return;
        }
        await this.fenced(run, async (tx) => {
          if (activeStep)
            await tx.query(
              "UPDATE step_runs SET status='FAILED',error=$3,finished_at=now() WHERE run_id=$1 AND step_id=$2",
              [run.id, activeStep.id, error],
            );
          await tx.query(
            "UPDATE runs SET status=$3,error=$2,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
            [
              run.id,
              error,
              e instanceof AppError && e.code === "CANCELLED"
                ? "CANCELLED"
                : "FAILED",
            ],
          );
          await this.store.event(
            tx,
            run.workspace_id,
            run.id,
            e instanceof AppError && e.code === "CANCELLED"
              ? "run.cancelled"
              : "run.failed",
            "worker",
            { stepId: activeStep?.id, error },
          );
        });
      } catch (secondary) {
        if (!(secondary instanceof LeaseLostError))
          console.error("Failed to persist run failure:", safeError(secondary));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      clearInterval(heartbeat);
      this.controllers.delete(controller);
    }
  }
  start() {
    if (this.loops.length) return;
    this.stopping = false;
    this.loops = Array.from(
      { length: this.store.config.concurrency },
      async () => {
        while (!this.stopping) {
          try {
            if (!(await this.tick())) await sleep(this.store.config.pollMs);
          } catch (e) {
            console.error("Worker error:", safeError(e));
            await sleep(this.store.config.pollMs);
          }
        }
      },
    );
  }
  async stop() {
    this.stopping = true;
    for (const c of this.controllers) c.abort(new Error("Worker shutdown"));
    await Promise.all(this.loops);
    this.loops = [];
  }
}
