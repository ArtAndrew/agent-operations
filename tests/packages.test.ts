import { beforeAll, afterAll, it, expect } from "vitest";
import Fastify from "fastify";
import { createHmac, randomUUID } from "node:crypto";
import { fixture } from "./helpers.js";
import { Packages } from "../src/packages.js";
import { Engine } from "../src/engine.js";
import { app } from "../src/app.js";
import { createMcpServer } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrate } from "../src/db.js";

let f: Awaited<ReturnType<typeof fixture>>,
  api: Awaited<ReturnType<typeof app>>,
  packages: Packages;
const provider = Fastify();
const issues: Record<string, any>[] = [];
let posts = 0,
  lose = false,
  unavailable = false;
beforeAll(async () => {
  provider.get("/user", async () => ({ id: 7, login: "tester" }));
  provider.get("/repos/acme/work", async () => ({
    id: 42,
    full_name: "acme/work",
    has_issues: true,
  }));
  provider.post("/repos/acme/work/issues", async (req, reply) => {
    posts++;
    const n = issues.length + 1;
    const issue = {
      ...(req.body as object),
      id: n,
      number: n,
      state: "open",
      state_reason: null,
      user: { id: 7 },
      html_url: `https://github.com/acme/work/issues/${n}`,
    };
    issues.push(issue);
    if (lose) {
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    return reply.status(201).send(issue);
  });
  provider.get("/repos/acme/work/issues", async (req, reply) =>
    unavailable ? reply.status(503).send({}) : issues.filter((i) => !i.hidden),
  );
  provider.get<{ Params: { id: string } }>(
    "/repos/acme/work/issues/:id",
    async (req, reply) =>
      unavailable
        ? reply.status(401).send({})
        : issues.find((i) => String(i.number) === req.params.id) ||
          reply.status(404).send({}),
  );
  await provider.listen({ host: "127.0.0.1", port: 0 });
  f = await fixture([provider.listeningOrigin]);
  packages = new Packages(f.store);
  api = await app(f.db, f.config, { worker: false });
  await api.server.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await api?.server.close();
  await f?.close();
  await provider.close();
});
async function setup(wait = false, approval = false) {
  lose = false;
  unavailable = false;
  const w = await f.workspace();
  const c = await f.store.createConnector(w.identity, {
    name: "github",
    kind: "http",
    baseUrl: provider.listeningOrigin,
    secretHeaders: { Authorization: "Bearer test-only" },
  });
  const cfg = {
    name: "github-case",
    connection: c.id,
    owner: "acme",
    repo: "work",
    waitForCompleted: wait,
    requireApproval: approval,
    pollSeconds: 30,
    maxWaitHours: 1,
  };
  const p = await packages.install(w.identity, cfg);
  const input = {
    caseId: randomUUID(),
    title: "Investigate this case",
    body: "Description",
  };
  const submitted = await f.store.submit(
    w.identity,
    cfg.name,
    input,
    input.caseId,
  );
  return { ...w, cfg, p, input, run: submitted.run };
}
async function tick(id: string) {
  await f.db.query("UPDATE runs SET available_at=now() WHERE id=$1", [id]);
  await f.engine.tick();
}
it("migrates an existing database idempotently and installs an immutable package without leaking secrets", async () => {
  await migrate(f.db);
  await migrate(f.db);
  const x = await setup();
  const listed = await packages.list(x.id);
  expect(listed.items).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain(x.p.webhook.secret);
  await expect(packages.install(x.identity, x.cfg)).rejects.toMatchObject({
    code: "OPERATION_EXISTS",
  });
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("SUCCEEDED");
});
it("recovers a committed issue after a lost response without creating a second issue", async () => {
  const x = await setup(),
    before = posts;
  lose = true;
  await tick(x.run.id);
  lose = false;
  expect((await f.store.run(x.id, x.run.id)).status).toBe("SUCCEEDED");
  const duplicate = await f.store.submit(
    x.identity,
    x.cfg.name,
    x.input,
    "new-request",
  );
  await tick(duplicate.run.id);
  expect((await f.store.run(x.id, duplicate.run.id)).status).toBe("SUCCEEDED");
  expect(posts - before).toBe(1);
  const changed = await f.store.submit(
    x.identity,
    x.cfg.name,
    { ...x.input, title: "Changed" },
    "changed",
  );
  await tick(changed.run.id);
  expect((await f.store.run(x.id, changed.run.id)).status).toBe("FAILED");
  expect(posts - before).toBe(1);
});
it("persists unknown outcomes, survives a new worker and never replays an uncertain create", async () => {
  const x = await setup(),
    before = posts;
  lose = true;
  unavailable = true;
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("WAITING_EXTERNAL");
  await tick(x.run.id);
  expect(posts - before).toBe(1);
  unavailable = false;
  lose = false;
  await f.db.query("UPDATE runs SET available_at=now() WHERE id=$1", [
    x.run.id,
  ]);
  const restarted = new Engine(f.store);
  await restarted.tick();
  restarted.artifacts.close();
  expect((await f.store.run(x.id, x.run.id)).status).toBe("SUCCEEDED");
  expect(posts - before).toBe(1);
});
it("shares business identity across package installations and rejects a conflicting payload", async () => {
  const x = await setup(),
    before = posts;
  await tick(x.run.id);
  await packages.install(x.identity, { ...x.cfg, name: "another-case" });
  const repeated = await f.store.submit(
    x.identity,
    "another-case",
    x.input,
    "second-package",
  );
  await tick(repeated.run.id);
  expect((await f.store.run(x.id, repeated.run.id)).status).toBe("SUCCEEDED");
  const conflicting = await f.store.submit(
    x.identity,
    "another-case",
    { ...x.input, body: "Different request" },
    "conflicting-package",
  );
  await tick(conflicting.run.id);
  expect((await f.store.run(x.id, conflicting.run.id)).status).toBe("FAILED");
  expect(posts - before).toBe(1);
});
it("requires exact approval before a real write", async () => {
  const x = await setup(false, true),
    before = posts;
  await tick(x.run.id);
  const detail = await f.store.detail(x.id, x.run.id);
  expect(detail.run.status).toBe("WAITING_APPROVAL");
  expect(posts).toBe(before);
  const approval = detail.approvals[0] as { id: string };
  await f.store.decide(
    x.identity,
    approval.id,
    "APPROVED",
    "Reviewed the exact repository and issue content",
  );
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("SUCCEEDED");
  expect(posts).toBe(before + 1);
});
it("uses authenticated, deduplicated webhooks only to wake polling; ignores stale event state", async () => {
  const x = await setup(true);
  await tick(x.run.id);
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("WAITING_EXTERNAL");
  const issue = issues.at(-1)!;
  const payload = JSON.stringify({
    action: "closed",
    repository: { full_name: "acme/work" },
    issue: { ...issue, state: "closed", state_reason: "completed" },
  });
  const headers = {
    "content-type": "application/json",
    "x-github-event": "issues",
    "x-github-delivery": randomUUID(),
    "x-hub-signature-256":
      "sha256=" +
      createHmac("sha256", x.p.webhook.secret).update(payload).digest("hex"),
  };
  expect(
    (
      await api.server.inject({
        method: "POST",
        url: x.p.webhook.path,
        headers: { ...headers, "x-hub-signature-256": "sha256=bad" },
        payload,
      })
    ).statusCode,
  ).toBe(401);
  const sent = await api.server.inject({
    method: "POST",
    url: x.p.webhook.path,
    headers,
    payload,
  });
  expect(sent.statusCode).toBe(200);
  const malformed = JSON.stringify({ repository: { full_name: 42 } });
  expect(
    (
      await api.server.inject({
        method: "POST",
        url: x.p.webhook.path,
        headers: {
          ...headers,
          "x-hub-signature-256":
            "sha256=" +
            createHmac("sha256", x.p.webhook.secret)
              .update(malformed)
              .digest("hex"),
        },
        payload: malformed,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await api.server.inject({
        method: "POST",
        url: x.p.webhook.path,
        headers,
        payload,
      })
    ).json().duplicate,
  ).toBe(true);
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("WAITING_EXTERNAL");
  issue.state = "closed";
  issue.state_reason = "not_planned";
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("WAITING_EXTERNAL");
  issue.state_reason = "completed";
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("SUCCEEDED");
});
it("cancels a read-only wait while retaining the verified issue receipt", async () => {
  const x = await setup(true);
  await tick(x.run.id);
  await tick(x.run.id);
  await f.store.cancel(
    x.identity,
    x.run.id,
    "No longer need to watch this issue",
  );
  const run = await f.store.run(x.id, x.run.id);
  expect(run.status).toBe("CANCELLED");
  expect(run.outputs.create_issue).toBeTruthy();
});
it("stops automatic verification after the deadline and prevents cancellation from hiding an unknown write", async () => {
  const x = await setup(),
    before = posts;
  lose = true;
  unavailable = true;
  await tick(x.run.id);
  await expect(
    f.store.cancel(x.identity, x.run.id, "Please stop"),
  ).rejects.toMatchObject({ code: "UNRESOLVED_EFFECT" });
  await f.db.query(
    "UPDATE step_runs SET recheck_started_at=now()-interval '2 hours' WHERE run_id=$1",
    [x.run.id],
  );
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("NEEDS_ATTENTION");
  expect(posts - before).toBe(1);
  unavailable = false;
  lose = false;
});
it("rejects modified issue content as completion evidence", async () => {
  const x = await setup(true);
  await tick(x.run.id);
  await tick(x.run.id);
  const issue = issues.at(-1)!;
  issue.state = "closed";
  issue.state_reason = "completed";
  issue.body = "Different body";
  await tick(x.run.id);
  expect((await f.store.run(x.id, x.run.id)).status).toBe("WAITING_EXTERNAL");
  await f.store.cancel(x.identity, x.run.id, "Stop watching modified issue");
});
it("isolates installations and restricts installation to administrators", async () => {
  const x = await setup(),
    other = await f.workspace();
  const viewer = await f.store.createKey(x.identity, "Read only", "viewer");
  const readOnlyServer = createMcpServer(
    api.server.listeningOrigin,
    viewer.token,
  );
  const readOnlyClient = new Client({ name: "viewer-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await readOnlyServer.connect(left);
  await readOnlyClient.connect(right);
  try {
    expect(
      (
        await readOnlyClient.callTool({
          name: "run_github-case",
          arguments: { requestKey: "viewer-request", input: x.input },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await readOnlyClient.close();
    await readOnlyServer.close();
  }
  expect(
    (
      await api.server.inject({
        method: "POST",
        url: "/api/v1/packages/github-issues/install",
        headers: { authorization: "Bearer " + viewer.token },
        payload: x.cfg,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await api.server.inject({
        url: "/api/v1/packages",
        headers: { authorization: "Bearer " + other.token },
      })
    ).json().items,
  ).toEqual([]);
  await tick(x.run.id);
});
it("serves real MCP discovery, idempotent submission and status without exposing approval tools", async () => {
  const x = await setup();
  await tick(x.run.id);
  const server = createMcpServer(api.server.listeningOrigin, x.token);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      "run_github-case",
      "operation_status",
    ]);
    const args = {
      requestKey: "mcp-request",
      input: { ...x.input, caseId: "mcp-case" },
    };
    const one = await client.callTool({
      name: "run_github-case",
      arguments: args,
    });
    const result = JSON.parse((one.content as { text: string }[])[0]!.text);
    expect(result.run.status).toBe("QUEUED");
    const two = await client.callTool({
      name: "run_github-case",
      arguments: args,
    });
    expect(
      JSON.parse((two.content as { text: string }[])[0]!.text).run.id,
    ).toBe(result.run.id);
    await tick(result.run.id);
    const status = await client.callTool({
      name: "operation_status",
      arguments: { runId: result.run.id },
    });
    expect(
      JSON.parse((status.content as { text: string }[])[0]!.text).run.status,
    ).toBe("SUCCEEDED");
    expect(
      (await client.callTool({ name: "approve", arguments: {} })).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
