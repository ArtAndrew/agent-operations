import { beforeAll, afterAll, describe, it, expect } from "vitest";
import Fastify from "fastify";
import { fixture, writeOperation } from "./helpers.js";
import { Engine } from "../src/engine.js";
import { Executors } from "../src/executors.js";
import { hash, sleep, encrypt } from "../src/util.js";

describe("durable operations against a real HTTP provider", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const provider = Fastify(),
    orders = new Map<string, Record<string, unknown>>();
  let posts = 0,
    gate: Promise<void> | undefined;
  beforeAll(async () => {
    provider.post("/orders", async (req, reply) => {
      posts++;
      const body = req.body as { id: string; mode?: string };
      if (gate) await gate;
      if (body.mode === "before")
        return reply.status(503).send({ error: "Temporarily unavailable" });
      orders.set(body.id, { ...body, status: "created" });
      if (body.mode === "lost") {
        reply.hijack();
        reply.raw.destroy();
        return;
      }
      return orders.get(body.id);
    });
    provider.get<{ Params: { id: string } }>(
      "/orders/:id",
      async (req, reply) => {
        const row = orders.get(req.params.id);
        if (row?.mode === "unknown")
          return reply.status(503).send({ error: "Unavailable" });
        return row || reply.status(404).send({ error: "Not found" });
      },
    );
    await provider.listen({ host: "127.0.0.1", port: 0 });
    f = await fixture([provider.listeningOrigin]);
  });
  afterAll(async () => {
    await f?.close();
    await provider.close();
  });
  async function setup(extra: Record<string, unknown> = {}) {
    const w = await f.workspace();
    await f.store.createConnector(w.identity, {
      name: "provider",
      kind: "http",
      baseUrl: provider.listeningOrigin,
      idempotencyHeader: "Idempotency-Key",
    });
    await f.store.register(w.identity, writeOperation("create-order", extra));
    return w;
  }
  async function finish(id: string, workspaceId: string) {
    for (let i = 0; i < 12; i++) {
      const run = await f.store.run(workspaceId, id);
      if (
        [
          "SUCCEEDED",
          "FAILED",
          "NEEDS_ATTENTION",
          "WAITING_APPROVAL",
          "CANCELLED",
        ].includes(run.status)
      )
        return run;
      await f.db.query("UPDATE runs SET available_at=now() WHERE id=$1", [id]);
      await f.engine.tick();
    }
    throw new Error("Run did not settle");
  }
  it("validates input, executes, verifies external state and deduplicates a submission", async () => {
    const w = await setup(),
      before = posts;
    await expect(
      f.store.submit(w.identity, "create-order", {}, "bad"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const a = await f.store.submit(
      w.identity,
      "create-order",
      { id: "normal" },
      "request-1",
    );
    const b = await f.store.submit(
      w.identity,
      "create-order",
      { id: "normal" },
      "request-1",
    );
    expect(b.replayed).toBe(true);
    expect(b.run.id).toBe(a.run.id);
    await expect(
      f.store.submit(w.identity, "create-order", { id: "other" }, "request-1"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await finish(a.run.id, w.id)).status).toBe("SUCCEEDED");
    expect(posts - before).toBe(1);
    const detail = await f.store.detail(w.id, a.run.id);
    expect(detail.attempts.map((a) => a.phase)).toEqual(["execute", "verify"]);
    expect(detail.steps[0]?.output).toMatchObject({
      id: "normal",
      status: "created",
    });
  });
  it("recovers a lost response without dispatching the write twice", async () => {
    const w = await setup(),
      before = posts;
    const { run } = await f.store.submit(
      w.identity,
      "create-order",
      { id: "lost", mode: "lost" },
      "lost",
    );
    expect((await finish(run.id, w.id)).status).toBe("SUCCEEDED");
    expect(posts - before).toBe(1);
    const receipt = (
      await f.db.query<{ receipt: { recovered: boolean } }>(
        "SELECT receipt FROM action_ledger WHERE workspace_id=$1",
        [w.id],
      )
    ).rows[0]!.receipt;
    expect(receipt.recovered).toBe(true);
  });
  it("stops an uncertain mutation and reconciles using reads only", async () => {
    const w = await setup(),
      before = posts;
    const { run } = await f.store.submit(
      w.identity,
      "create-order",
      { id: "uncertain", mode: "unknown" },
      "uncertain",
    );
    expect((await finish(run.id, w.id)).status).toBe("NEEDS_ATTENTION");
    await f.store.reconcile(w.identity, run.id, "Check provider again");
    expect((await finish(run.id, w.id)).status).toBe("NEEDS_ATTENTION");
    orders.set("uncertain", { id: "uncertain", status: "created" });
    await f.store.reconcile(w.identity, run.id, "Provider is healthy");
    expect((await finish(run.id, w.id)).status).toBe("SUCCEEDED");
    expect(posts - before).toBe(1);
  });
  it("retries only with provider idempotency and a confirmed absence", async () => {
    const w = await setup({ retry: { maxAttempts: 2, delayMs: 100 } }),
      before = posts;
    const { run } = await f.store.submit(
      w.identity,
      "create-order",
      { id: "before", mode: "before" },
      "before",
    );
    expect((await finish(run.id, w.id)).status).toBe("NEEDS_ATTENTION");
    expect(posts - before).toBe(2);
  });
  it("binds approval to the persisted action and enforces separate identities", async () => {
    const w = await setup({ approval: true }),
      before = posts;
    await f.db.query(
      "UPDATE workspaces SET two_person_approval=true WHERE id=$1",
      [w.id],
    );
    const { run } = await f.store.submit(
      w.identity,
      "create-order",
      { id: "approved" },
      "approval",
    );
    expect((await finish(run.id, w.id)).status).toBe("WAITING_APPROVAL");
    expect(posts).toBe(before);
    const approval = (await f.store.detail(w.id, run.id)).approvals[0] as {
      id: string;
      digest: string;
    };
    await expect(
      f.store.decide(w.identity, approval.id, "APPROVED", "Looks correct"),
    ).rejects.toMatchObject({ code: "SEPARATION_OF_DUTIES" });
    const key = await f.store.createKey(w.identity, "Reviewer", "reviewer");
    await f.store.decide(
      await f.store.authenticate(key.token),
      approval.id,
      "APPROVED",
      "Approved exact payload",
    );
    expect((await finish(run.id, w.id)).status).toBe("SUCCEEDED");
    expect(posts - before).toBe(1);
    expect((await f.store.detail(w.id, run.id)).steps[0]?.digest).toBe(
      approval.digest,
    );
  });
  it("never concurrently dispatches two runs with the same business action", async () => {
    const w = await setup(),
      before = posts;
    let release!: () => void;
    gate = new Promise<void>((r) => {
      release = r;
    });
    try {
      const a = await f.store.submit(
        w.identity,
        "create-order",
        { id: "race" },
        "race-a",
      );
      const b = await f.store.submit(
        w.identity,
        "create-order",
        { id: "race" },
        "race-b",
      );
      const worker1 = new Engine(f.store),
        worker2 = new Engine(f.store);
      const first = worker1.tick();
      for (let i = 0; i < 100 && posts === before; i++) await sleep(10);
      expect(posts).toBe(before + 1);
      await worker2.tick();
      expect(posts).toBe(before + 1);
      expect((await f.store.run(w.id, b.run.id)).status).toBe("RETRYING");
      release();
      gate = undefined;
      await first;
      expect((await finish(a.run.id, w.id)).status).toBe("SUCCEEDED");
      expect((await finish(b.run.id, w.id)).status).toBe("SUCCEEDED");
      expect(posts - before).toBe(1);
    } finally {
      release();
      gate = undefined;
    }
  });
  it("recovers a crash after external commit using the expired lease", async () => {
    const w = await setup(),
      before = posts;
    const { run } = await f.store.submit(
      w.identity,
      "create-order",
      { id: "crash" },
      "crash",
    );
    const executor = new Executors(f.store),
      execute = executor.execute.bind(executor);
    executor.execute = async (...args) => {
      const result = await execute(...args);
      await f.db.query(
        "UPDATE runs SET lease_token=NULL,lease_until=now()-interval '1 second' WHERE id=$1",
        [run.id],
      );
      return result;
    };
    await new Engine(f.store, executor).tick();
    expect((await f.store.detail(w.id, run.id)).steps[0]?.status).toBe(
      "DISPATCHED",
    );
    expect((await finish(run.id, w.id)).status).toBe("SUCCEEDED");
    expect(posts - before).toBe(1);
  });
  it("rejects a reused business key with changed payload", async () => {
    const w = await setup();
    const a = await f.store.submit(
      w.identity,
      "create-order",
      { id: "conflict" },
      "c1",
    );
    await finish(a.run.id, w.id);
    const before = posts,
      b = await f.store.submit(
        w.identity,
        "create-order",
        { id: "conflict", mode: "different" },
        "c2",
      );
    const result = await finish(b.run.id, w.id);
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/different action/);
    expect(posts).toBe(before);
  });
  it("cancels before dispatch and does not allow cancelling an unresolved write", async () => {
    const w = await setup(),
      before = posts;
    const { run } = await f.store.submit(
      w.identity,
      "create-order",
      { id: "cancel" },
      "cancel",
    );
    await f.store.cancel(w.identity, run.id, "No longer needed");
    expect((await finish(run.id, w.id)).status).toBe("CANCELLED");
    expect(posts).toBe(before);
    const uncertain = await f.store.submit(
      w.identity,
      "create-order",
      { id: "cancel-unknown", mode: "unknown" },
      "u",
    );
    await finish(uncertain.run.id, w.id);
    await expect(
      f.store.cancel(w.identity, uncertain.run.id, "No longer needed"),
    ).rejects.toMatchObject({ code: "UNRESOLVED_EFFECT" });
  });
  it("chains audit records over exactly the data persisted to PostgreSQL", async () => {
    const w = await setup();
    const { run } = await f.store.submit(
      w.identity,
      "create-order",
      { id: "audit" },
      "audit",
    );
    await finish(run.id, w.id);
    await f.db.transaction((tx) =>
      f.store.event(tx, w.id, null, "test.optional", "test", {
        present: 1,
        missing: undefined,
      }),
    );
    const events = (
      await f.db.query<{
        previous_hash: string;
        hash: string;
        run_id: string | null;
        type: string;
        actor: string;
        data: unknown;
      }>("SELECT * FROM events WHERE workspace_id=$1 ORDER BY id", [w.id])
    ).rows;
    let previous = "genesis";
    for (const event of events) {
      expect(event.previous_hash).toBe(previous);
      expect(event.hash).toBe(
        hash({
          previous,
          workspaceId: w.id,
          runId: event.run_id,
          type: event.type,
          actor: event.actor,
          data: event.data,
        }),
      );
      previous = event.hash;
    }
  });
  it("coordinates simultaneous prepared actions before any worker dispatches", async () => {
    const w = await setup(),
      before = posts,
      runs = [];
    for (let i = 0; i < 12; i++)
      runs.push(
        (
          await f.store.submit(
            w.identity,
            "create-order",
            { id: "parallel-prepared" },
            "parallel-" + i,
          )
        ).run,
      );
    const claims = [];
    for (let i = 0; i < runs.length; i++)
      claims.push((await f.engine.claim())!);
    expect(claims.every(Boolean)).toBe(true);
    await Promise.all(claims.map((run) => new Engine(f.store).process(run)));
    for (const run of runs)
      expect((await finish(run.id, w.id)).status).toBe("SUCCEEDED");
    expect(posts - before).toBe(1);
  });
  it("verifies an in-flight write before honoring cancellation", async () => {
    const w = await setup(),
      before = posts;
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const { run } = await f.store.submit(
        w.identity,
        "create-order",
        { id: "cancel-in-flight" },
        "cancel-in-flight",
      );
      const processing = f.engine.tick();
      for (let i = 0; i < 100 && posts === before; i++) await sleep(10);
      expect(posts).toBe(before + 1);
      await f.store.cancel(w.identity, run.id, "Stop after current action");
      release();
      gate = undefined;
      await processing;
      const result = await f.store.detail(w.id, run.id);
      expect(result.run.status).toBe("CANCELLED");
      expect(result.steps[0]?.status).toBe("SUCCEEDED");
      expect(result.run.outputs.create).toMatchObject({ status: "created" });
      expect(posts - before).toBe(1);
    } finally {
      release();
      gate = undefined;
    }
  });
  it("does not reuse approval after connector credentials change", async () => {
    const w = await setup({ approval: true }),
      before = posts;
    const { run } = await f.store.submit(
      w.identity,
      "create-order",
      { id: "rotated-approval" },
      "rotation",
    );
    expect((await finish(run.id, w.id)).status).toBe("WAITING_APPROVAL");
    const approval = (await f.store.detail(w.id, run.id)).approvals[0] as {
      id: string;
    };
    await f.db.query(
      "UPDATE connectors SET secret_ciphertext=$2 WHERE workspace_id=$1",
      [
        w.id,
        encrypt(
          { Authorization: "Bearer different-account" },
          f.config.masterKey,
        ),
      ],
    );
    await f.store.decide(
      w.identity,
      approval.id,
      "APPROVED",
      "Reviewed original account",
    );
    const result = await finish(run.id, w.id);
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/Connection credentials/);
    expect(posts).toBe(before);
  });
  it("reuses a submission across later definition versions when no version is specified", async () => {
    const w = await setup();
    const a = await f.store.submit(
      w.identity,
      "create-order",
      { id: "sticky-version" },
      "sticky",
    );
    await f.store.register(
      w.identity,
      writeOperation("create-order", { approval: true }),
    );
    const b = await f.store.submit(
      w.identity,
      "create-order",
      { id: "sticky-version" },
      "sticky",
    );
    expect(b.replayed).toBe(true);
    expect(b.run.id).toBe(a.run.id);
    expect(b.run.version).toBe(1);
    await expect(
      f.store.submit(
        w.identity,
        "create-order",
        { id: "sticky-version" },
        "sticky",
        2,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await finish(a.run.id, w.id);
  });
});
