import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { fixture, writeOperation } from "./helpers.js";
import Fastify from "fastify";
import { app } from "../src/app.js";

describe("workspace API security and lifecycle", () => {
  let f: Awaited<ReturnType<typeof fixture>>,
    a: Awaited<ReturnType<typeof app>>;
  beforeAll(async () => {
    f = await fixture(["https://example.com"]);
    a = await app(f.db, f.config, { worker: false });
  });
  afterAll(async () => {
    await a?.server.close();
    await f?.close();
  });
  const auth = (token: string) => ({ authorization: "Bearer " + token });
  async function setup() {
    return f.workspace();
  }
  it("requires authentication and separates platform from workspace privileges", async () => {
    expect((await a.server.inject("/api/v1/runs")).statusCode).toBe(401);
    const platform = await a.server.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: auth(f.config.adminToken),
      payload: { name: "Platform-created" },
    });
    expect(platform.statusCode).toBe(201);
    expect(platform.json().token).toMatch(/^aok_/);
    expect(
      (
        await a.server.inject({
          url: "/api/v1/runs",
          headers: auth(f.config.adminToken),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await a.server.inject({
          url: "/api/v1/workspaces",
          headers: auth(platform.json().token),
        })
      ).statusCode,
    ).toBe(403);
  });
  it("isolates runs, keys, connectors and artifacts across workspaces", async () => {
    const one = await setup(),
      two = await setup();
    await f.store.register(one.identity, {
      name: "echo",
      steps: [{ id: "result", kind: "transform", value: "{{ input }}" }],
    });
    const { run } = await f.store.submit(
      one.identity,
      "echo",
      { value: 1 },
      "one",
    );
    await f.engine.tick();
    const artifact = await f.engine.artifacts.save(one.id, run.id, "result", {
      name: "receipt.txt",
      content: Buffer.from("receipt"),
      contentType: "text/plain",
    });
    expect(
      (
        await a.server.inject({
          url: "/api/v1/runs/" + run.id,
          headers: auth(two.token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await a.server.inject({
          url: "/api/v1/artifacts/" + artifact,
          headers: auth(two.token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await a.server.inject({
          url: "/api/v1/operations/echo",
          headers: auth(two.token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await a.server.inject({
          method: "DELETE",
          url: "/api/v1/keys/" + one.keyId,
          headers: auth(two.token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await a.server.inject({
          url: "/api/v1/artifacts/" + artifact,
          headers: auth(one.token),
        })
      ).body,
    ).toBe("receipt");
  });
  it("enforces roles, hashed credentials and key revocation", async () => {
    const w = await setup(),
      key = await f.store.createKey(w.identity, "Read only", "viewer");
    const denied = await a.server.inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { ...auth(key.token), "idempotency-key": "test" },
      payload: { operation: "echo" },
    });
    expect(denied.statusCode).toBe(403);
    const rows = await f.db.query("SELECT * FROM api_keys WHERE id=$1", [
      key.id,
    ]);
    expect(JSON.stringify(rows)).not.toContain(key.token);
    await f.store.revokeKey(w.identity, key.id);
    expect(
      (await a.server.inject({ url: "/api/v1/me", headers: auth(key.token) }))
        .statusCode,
    ).toBe(401);
  });
  it("encrypts connector credentials and never returns them from list APIs or events", async () => {
    const w = await setup(),
      secret = "provider-secret-do-not-log";
    const created = await a.server.inject({
      method: "POST",
      url: "/api/v1/connectors",
      headers: auth(w.token),
      payload: {
        name: "provider",
        kind: "http",
        baseUrl: "https://example.com",
        secretHeaders: { Authorization: "Bearer " + secret },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(secret);
    const connector = await f.store.connector(w.id, "provider");
    expect(JSON.stringify(connector)).not.toContain(secret);
    expect(f.store.connectorHeaders(connector).Authorization).toBe(
      "Bearer " + secret,
    );
    const listed = await a.server.inject({
      url: "/api/v1/connectors",
      headers: auth(w.token),
    });
    expect(listed.body).not.toContain(secret);
    expect(listed.json().items[0].has_secrets).toBe(true);
    expect(
      (await a.server.inject({ url: "/api/v1/events", headers: auth(w.token) }))
        .body,
    ).not.toContain(secret);
    const denied = await a.server.inject({
      method: "PUT",
      url: "/api/v1/connectors/" + connector.id + "/credentials",
      headers: auth(w.token),
      payload: { secretHeaders: { Host: "attacker.example" } },
    });
    expect(denied.statusCode).toBe(400);
  });
  it("uses HTTP-only sessions and rejects cross-origin mutations", async () => {
    const w = await setup();
    const login = await a.server.inject({
      method: "POST",
      url: "/api/session",
      payload: { token: w.token },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect(
      (await a.server.inject({ url: "/api/v1/me", headers: { cookie } })).json()
        .workspaceId,
    ).toBe(w.id);
    const blocked = await a.server.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { cookie, origin: "https://attacker.example" },
      payload: { name: "Injected", role: "admin" },
    });
    expect(blocked.statusCode).toBe(403);
  });
  it("enforces operation versions and daily quotas", async () => {
    const w = await setup();
    const first = await f.store.register(w.identity, {
      name: "echo",
      steps: [{ id: "result", kind: "transform", value: 1 }],
    });
    const second = await f.store.register(w.identity, {
      name: "echo",
      steps: [{ id: "result", kind: "transform", value: 2 }],
    });
    expect([first.version, second.version]).toEqual([1, 2]);
    await f.db.query("UPDATE workspaces SET max_runs_per_day=1 WHERE id=$1", [
      w.id,
    ]);
    const { run } = await f.store.submit(w.identity, "echo", {}, "pinned", 1);
    await f.engine.tick();
    expect((await f.store.run(w.id, run.id)).outputs).toEqual({ result: 1 });
    await expect(
      f.store.submit(w.identity, "echo", {}, "over-quota"),
    ).rejects.toMatchObject({ code: "DAILY_QUOTA" });
  });
  it("requires verifiable mutations and keeps model steps read-only", async () => {
    const w = await setup();
    await expect(
      f.store.register(w.identity, {
        name: "unsafe",
        steps: [
          {
            id: "write",
            kind: "http",
            connection: "any",
            request: { method: "POST", path: "/" },
          },
        ],
      }),
    ).rejects.toBeDefined();
    await expect(
      f.store.register(w.identity, {
        name: "unsafe",
        steps: [
          {
            id: "write",
            kind: "browser",
            connection: "any",
            actions: [{ action: "click", selector: "button" }],
          },
        ],
      }),
    ).rejects.toBeDefined();
  });
  it("detects modifications to the audit chain", async () => {
    const w = await setup();
    const before = await a.server.inject({
      url: "/api/v1/audit/verify",
      headers: auth(w.token),
    });
    expect(before.json().valid).toBe(true);
    await f.db.query(
      "UPDATE events SET data='{\"tampered\":true}'::jsonb WHERE workspace_id=$1",
      [w.id],
    );
    const after = await a.server.inject({
      url: "/api/v1/audit/verify",
      headers: auth(w.token),
    });
    expect(after.json().valid).toBe(false);
  });
  it("requires separate reviewer evidence for manual resolution and resumes the run", async () => {
    const provider = Fastify();
    provider.post("/orders", async () => ({ accepted: true }));
    provider.get("/orders/:id", async (_request, reply) =>
      reply.status(503).send({ unavailable: true }),
    );
    await provider.listen({ host: "127.0.0.1", port: 0 });
    f.config.allowedOrigins.add(provider.listeningOrigin);
    try {
      const w = await setup();
      await f.store.createConnector(w.identity, {
        name: "provider",
        kind: "http",
        baseUrl: provider.listeningOrigin,
      });
      await f.store.register(w.identity, writeOperation());
      await f.db.query(
        "UPDATE workspaces SET two_person_approval=true WHERE id=$1",
        [w.id],
      );
      const { run } = await f.store.submit(
        w.identity,
        "create-order",
        { id: "manual" },
        "manual",
      );
      await f.engine.tick();
      expect((await f.store.run(w.id, run.id)).status).toBe("NEEDS_ATTENTION");
      const payload = {
        outcome: "confirmed",
        reason: "Supplier investigation confirmed commit",
        evidence: "Receipt order-manual",
        output: { id: "manual", status: "created" },
      };
      const own = await a.server.inject({
        method: "POST",
        url: "/api/v1/runs/" + run.id + "/resolve",
        headers: auth(w.token),
        payload,
      });
      expect(own.statusCode).toBe(403);
      const reviewer = await f.store.createKey(
        w.identity,
        "Independent reviewer",
        "reviewer",
      );
      const resolution = await a.server.inject({
        method: "POST",
        url: "/api/v1/runs/" + run.id + "/resolve",
        headers: auth(reviewer.token),
        payload,
      });
      expect(resolution.statusCode, resolution.body).toBe(200);
      await f.engine.tick();
      expect((await f.store.run(w.id, run.id)).status).toBe("SUCCEEDED");
      const audit = await a.server.inject({
        url: "/api/v1/audit/verify",
        headers: auth(w.token),
      });
      expect(audit.json().valid).toBe(true);
    } finally {
      await provider.close();
    }
  });
});
