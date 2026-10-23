import { Packages } from "./packages.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { Store, validateHeaders } from "./store.js";
import { Engine } from "./engine.js";
import {
  AppError,
  ExecutionError,
  type Identity,
  type Role,
  type Run,
  type StepRun,
} from "./domain.js";
import { equalToken, hash } from "./util.js";
declare module "fastify" {
  interface FastifyRequest {
    identity?: Identity;
    platform?: boolean;
  }
}
const name = z.string().trim().min(1).max(100);
const keyBody = z.object({
  name,
  role: z.enum(["admin", "operator", "reviewer", "viewer"]),
});
const reason = z.string().trim().min(3).max(2000);
export async function app(
  db: Database,
  config: Config,
  options: { worker?: boolean; demoToken?: string } = {},
) {
  const store = new Store(db, config),
    engine = new Engine(store);
  const server = Fastify({
    bodyLimit: 1_000_000,
    logger: false,
    trustProxy: false,
  });
  await server.register(cookie, { secret: config.masterKey.toString("hex") });
  await server.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  server.decorateRequest("identity", undefined);
  server.decorateRequest("platform", false);
  server.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (
      ["POST", "PATCH", "PUT", "DELETE"].includes(request.method) &&
      request.headers.origin
    ) {
      const expected =
        config.publicOrigin ||
        new URL(request.protocol + "://" + request.host).origin;
      let origin: string;
      try {
        origin = new URL(request.headers.origin).origin;
      } catch {
        throw new AppError(403, "ORIGIN_DENIED", "Invalid request origin");
      }
      if (origin !== expected)
        throw new AppError(
          403,
          "ORIGIN_DENIED",
          "Cross-origin state changes are not allowed",
        );
    }
    if (!request.url.startsWith("/api/v1/")) return;
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const signed = request.cookies.aop_session
      ? request.unsignCookie(request.cookies.aop_session)
      : undefined;
    const token = bearer || (signed?.valid ? signed.value : undefined);
    if (!token)
      throw new AppError(
        401,
        "UNAUTHORIZED",
        "Sign in with a workspace API key",
      );
    if (equalToken(token, config.adminToken)) {
      request.platform = true;
      return;
    }
    request.identity = await store.authenticate(token);
  });
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues,
        },
      });
    if (error instanceof ExecutionError)
      return reply.status(502).send({
        error: { code: "PROVIDER_UNAVAILABLE", message: error.message },
      });
    if (error instanceof AppError)
      return reply
        .status(error.status)
        .send({ error: { code: error.code, message: error.message } });
    if ((error as { code?: string }).code === "23505")
      return reply.status(409).send({
        error: { code: "CONFLICT", message: "This resource already exists" },
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.status(status).send({
        error: {
          code: "BAD_REQUEST",
          message:
            status === 429 ? "Request rate limit reached" : "Invalid request",
        },
      });
    console.error(
      "Request failed:",
      error instanceof Error ? error.message : "Unexpected error",
    );
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      },
    });
  });
  const identity = (
    request: { identity?: Identity },
    roles: Role[] = ["admin", "operator", "reviewer", "viewer"],
  ) => {
    if (!request.identity)
      throw new AppError(403, "WORKSPACE_REQUIRED", "Use a workspace API key");
    if (!roles.includes(request.identity.role))
      throw new AppError(
        403,
        "FORBIDDEN",
        "Your role does not permit this action",
      );
    return request.identity;
  };
  const packages = new Packages(store);
  server.get("/api/v1/packages", async (request) =>
    packages.list(identity(request).workspaceId),
  );
  server.post("/api/v1/packages/github-issues/check", async (request) =>
    packages.check(identity(request, ["admin"]), request.body),
  );
  server.post(
    "/api/v1/packages/github-issues/install",
    async (request, reply) => {
      const result = await packages.install(
        identity(request, ["admin"]),
        request.body,
      );
      reply.status(201);
      return result;
    },
  );
  await server.register(async (hooks) => {
    hooks.removeContentTypeParser("application/json");
    hooks.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    hooks.post<{ Params: { id: string } }>(
      "/hooks/github/:id",
      async (request) =>
        packages.webhook(
          request.params.id,
          request.body as Buffer,
          String(request.headers["x-hub-signature-256"] || ""),
          String(request.headers["x-github-delivery"] || ""),
          String(request.headers["x-github-event"] || ""),
        ),
    );
  });
  const setSession = (
    reply: import("fastify").FastifyReply,
    token: string,
    secure: boolean,
  ) =>
    reply.setCookie("aop_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/",
      signed: true,
      maxAge: 8 * 3600,
    });
  server.get("/healthz", async () => ({ status: "ok" }));
  server.get("/readyz", async () => {
    await db.query("SELECT 1");
    return { status: "ready" };
  });
  server.get("/api/config", async () => ({
    name: "Agent Operations",
    version: "0.2.0",
    demo: !!options.demoToken,
  }));
  server.post(
    "/api/session",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { token } = z
        .object({ token: z.string().min(10).max(512) })
        .parse(request.body);
      const platform = equalToken(token, config.adminToken);
      if (!platform) await store.authenticate(token);
      setSession(
        reply,
        token,
        config.publicOrigin?.startsWith("https://") ||
          request.protocol === "https",
      );
      return { authenticated: true, platform };
    },
  );
  server.delete("/api/session", async (_request, reply) => {
    reply.clearCookie("aop_session", { path: "/" });
    return { ok: true };
  });
  if (options.demoToken) {
    if (!["127.0.0.1", "localhost", "::1"].includes(config.host))
      throw new Error("Demo login is restricted to a loopback server");
    server.post("/api/demo/session", async (request, reply) => {
      setSession(reply, options.demoToken!, false);
      return { authenticated: true };
    });
  }
  server.get("/api/v1/me", async (request) => {
    if (request.platform)
      return { platform: true, allowedOrigins: [...config.allowedOrigins] };
    const who = identity(request);
    const workspace = (
      await db.query("SELECT * FROM workspaces WHERE id=$1", [who.workspaceId])
    ).rows[0];
    return { ...who, workspace, allowedOrigins: [...config.allowedOrigins] };
  });
  server.get("/api/v1/workspaces", async (request) => {
    if (!request.platform)
      throw new AppError(
        403,
        "PLATFORM_REQUIRED",
        "Platform administrator access required",
      );
    return {
      items: (
        await db.query("SELECT * FROM workspaces ORDER BY created_at DESC")
      ).rows,
    };
  });
  server.post("/api/v1/workspaces", async (request, reply) => {
    if (!request.platform)
      throw new AppError(
        403,
        "PLATFORM_REQUIRED",
        "Platform administrator access required",
      );
    const body = z.object({ name }).parse(request.body);
    reply.status(201);
    return store.createWorkspace(body.name);
  });
  server.patch("/api/v1/workspace", async (request) => {
    const who = identity(request, ["admin"]);
    const body = z
      .object({
        name,
        maxRunsPerDay: z.number().int().min(1).max(1000000),
        maxConcurrentRuns: z.number().int().min(1).max(1000),
        twoPersonApproval: z.boolean(),
      })
      .parse(request.body);
    await db.transaction(async (tx) => {
      await tx.query(
        "UPDATE workspaces SET name=$2,max_runs_per_day=$3,max_concurrent_runs=$4,two_person_approval=$5 WHERE id=$1",
        [
          who.workspaceId,
          body.name,
          body.maxRunsPerDay,
          body.maxConcurrentRuns,
          body.twoPersonApproval,
        ],
      );
      await store.event(
        tx,
        who.workspaceId,
        null,
        "workspace.updated",
        who.keyId,
        body,
      );
    });
    return { ok: true };
  });
  server.get("/api/v1/keys", async (request) => {
    const who = identity(request, ["admin"]);
    return {
      items: (
        await db.query(
          "SELECT id,name,role,revoked_at,created_at FROM api_keys WHERE workspace_id=$1 ORDER BY created_at DESC",
          [who.workspaceId],
        )
      ).rows,
    };
  });
  server.post("/api/v1/keys", async (request, reply) => {
    const who = identity(request, ["admin"]),
      body = keyBody.parse(request.body);
    reply.status(201);
    return store.createKey(who, body.name, body.role);
  });
  server.delete<{ Params: { id: string } }>(
    "/api/v1/keys/:id",
    async (request) => {
      await store.revokeKey(identity(request, ["admin"]), request.params.id);
      return { ok: true };
    },
  );
  server.get("/api/v1/connectors", async (request) => {
    const who = identity(request);
    return {
      items: (
        await db.query(
          "SELECT id,name,kind,base_url,headers,idempotency_header,(secret_ciphertext IS NOT NULL) AS has_secrets,created_at FROM connectors WHERE workspace_id=$1 ORDER BY created_at DESC",
          [who.workspaceId],
        )
      ).rows,
    };
  });
  server.post("/api/v1/connectors", async (request, reply) => {
    const who = identity(request, ["admin"]),
      body = z
        .object({
          name,
          kind: z.enum(["http", "browser", "model"]),
          baseUrl: z.url().max(2000),
          headers: z.record(z.string(), z.string()).optional(),
          secretHeaders: z.record(z.string(), z.string()).optional(),
          idempotencyHeader: z
            .string()
            .regex(/^[A-Za-z0-9-]+$/)
            .optional(),
        })
        .parse(request.body);
    reply.status(201);
    return store.createConnector(who, body);
  });
  server.put<{ Params: { id: string } }>(
    "/api/v1/connectors/:id/credentials",
    async (request) => {
      const who = identity(request, ["admin"]),
        body = z
          .object({ secretHeaders: z.record(z.string(), z.string()) })
          .parse(request.body);
      const connector = await store.connector(
        who.workspaceId,
        request.params.id,
      );
      validateHeaders(body.secretHeaders);
      const { encrypt } = await import("./util.js");
      await db.transaction(async (tx) => {
        await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          who.workspaceId,
        ]);
        await tx.query(
          "UPDATE connectors SET secret_ciphertext=$3 WHERE workspace_id=$1 AND id=$2",
          [
            who.workspaceId,
            connector.id,
            encrypt(body.secretHeaders, config.masterKey),
          ],
        );
        await store.event(
          tx,
          who.workspaceId,
          null,
          "connector.credentials_rotated",
          who.keyId,
          { id: connector.id },
        );
      });
      return { ok: true };
    },
  );
  server.get("/api/v1/operations", async (request) => {
    const who = identity(request);
    return {
      items: (
        await db.query(
          "SELECT DISTINCT ON(name) id,name,version,definition,digest,created_at FROM operations WHERE workspace_id=$1 ORDER BY name,version DESC",
          [who.workspaceId],
        )
      ).rows,
    };
  });
  server.post("/api/v1/operations", async (request, reply) => {
    reply.status(201);
    return store.register(identity(request, ["admin"]), request.body);
  });
  server.get<{ Params: { name: string }; Querystring: { version?: string } }>(
    "/api/v1/operations/:name",
    async (request) => {
      const who = identity(request);
      const version = request.query.version
        ? z.coerce.number().int().positive().parse(request.query.version)
        : undefined;
      return store.operation(who.workspaceId, request.params.name, version);
    },
  );
  server.get("/api/v1/runs", async (request) => {
    const who = identity(request),
      q = z
        .object({
          status: z.string().max(40).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().optional(),
        })
        .parse(request.query);
    return {
      items: (
        await db.query(
          "SELECT * FROM runs WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR created_at<$3) ORDER BY created_at DESC,id DESC LIMIT $4",
          [who.workspaceId, q.status ?? null, q.before ?? null, q.limit],
        )
      ).rows,
    };
  });
  server.post("/api/v1/runs", async (request, reply) => {
    const who = identity(request, ["admin", "operator"]);
    const body = z
      .object({
        operation: z.string(),
        version: z.number().int().positive().optional(),
        input: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(request.body);
    const key = z
      .string()
      .min(1)
      .max(200)
      .parse(request.headers["idempotency-key"]);
    const result = await store.submit(
      who,
      body.operation,
      body.input,
      key,
      body.version,
    );
    reply.status(result.replayed ? 200 : 201);
    return result;
  });
  server.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (request) =>
    store.detail(identity(request).workspaceId, request.params.id),
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/cancel",
    async (request) => {
      const body = z.object({ reason }).parse(request.body);
      await store.cancel(
        identity(request, ["admin", "operator"]),
        request.params.id,
        body.reason,
      );
      return { ok: true };
    },
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/reconcile",
    async (request) => {
      const body = z.object({ reason }).parse(request.body);
      await store.reconcile(
        identity(request, ["admin", "operator", "reviewer"]),
        request.params.id,
        body.reason,
      );
      return { ok: true };
    },
  );
  server.post<{ Params: { id: string } }>(
    "/api/v1/runs/:id/resolve",
    async (request) => {
      const who = identity(request, ["admin", "reviewer"]),
        body = z
          .object({
            outcome: z.enum(["confirmed", "failed"]),
            reason,
            evidence: z.string().min(3).max(4000),
            output: z.unknown().optional(),
          })
          .parse(request.body);
      await db.transaction(async (tx) => {
        const workspace = (
          await tx.query<{ two_person_approval: boolean }>(
            "SELECT * FROM workspaces WHERE id=$1 FOR UPDATE",
            [who.workspaceId],
          )
        ).rows[0]!;
        const run = (
          await tx.query<Run>(
            "SELECT * FROM runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
            [request.params.id, who.workspaceId],
          )
        ).rows[0];
        if (!run) throw new AppError(404, "NOT_FOUND", "Run not found");
        if (workspace.two_person_approval && who.keyId === run.created_by)
          throw new AppError(
            403,
            "SEPARATION_OF_DUTIES",
            "A different API identity must resolve this operation",
          );
        if (run.status !== "NEEDS_ATTENTION")
          throw new AppError(
            409,
            "NOT_UNCERTAIN",
            "This run does not need manual resolution",
          );
        const step = (
          await tx.query<StepRun>(
            "SELECT * FROM step_runs WHERE run_id=$1 AND status='UNKNOWN' FOR UPDATE",
            [run.id],
          )
        ).rows[0];
        if (!step)
          throw new AppError(
            409,
            "NO_UNCERTAIN_STEP",
            "There is no uncertain action to resolve",
          );
        const output = body.output ?? step.output ?? null;
        if (step.action_key) {
          const action = (
            await tx.query<{ status: string; owner_run_id: string }>(
              "SELECT status,owner_run_id FROM action_ledger WHERE workspace_id=$1 AND action_key=$2 FOR UPDATE",
              [who.workspaceId, step.action_key],
            )
          ).rows[0];
          if (action?.status === "SUCCEEDED")
            throw new AppError(
              409,
              "ACTION_ALREADY_CONFIRMED",
              "Reconcile this run to reuse the already confirmed action result",
            );
          if (action && action.owner_run_id !== run.id) {
            const owner = (
              await tx.query<{ active: boolean }>(
                "SELECT lease_until>now() AS active FROM runs WHERE id=$1",
                [action.owner_run_id],
              )
            ).rows[0];
            if (owner?.active)
              throw new AppError(
                409,
                "ACTION_IN_PROGRESS",
                "Another run is still reconciling this business action",
              );
          }
        }
        if (step.action_key)
          await tx.query(
            "UPDATE action_ledger SET status=$3,output=$4::jsonb,receipt=$5::jsonb,updated_at=now() WHERE workspace_id=$1 AND action_key=$2",
            [
              who.workspaceId,
              step.action_key,
              body.outcome === "confirmed" ? "SUCCEEDED" : "FAILED",
              JSON.stringify(output),
              JSON.stringify({
                source: "operator",
                actor: who.keyId,
                evidence: body.evidence,
                reason: body.reason,
              }),
            ],
          );
        await tx.query(
          "UPDATE step_runs SET status=$2,output=$3::jsonb,finished_at=now(),error=$4 WHERE id=$1",
          [
            step.id,
            body.outcome === "confirmed" ? "SUCCEEDED" : "FAILED",
            JSON.stringify(output),
            body.outcome === "failed" ? body.reason : null,
          ],
        );
        await tx.query(
          "UPDATE runs SET status=$2,next_step=next_step+$3,outputs=$4::jsonb,error=$5,available_at=now(),updated_at=now() WHERE id=$1",
          [
            run.id,
            body.outcome === "confirmed" ? "QUEUED" : "FAILED",
            body.outcome === "confirmed" ? 1 : 0,
            JSON.stringify({ ...run.outputs, [step.step_id]: output }),
            body.outcome === "failed" ? body.reason : null,
          ],
        );
        await store.event(
          tx,
          who.workspaceId,
          run.id,
          "action.manually_resolved",
          who.keyId,
          { stepId: step.step_id, ...body, output: undefined },
        );
      });
      return { ok: true };
    },
  );
  server.get("/api/v1/approvals", async (request) => {
    const who = identity(request);
    return {
      items: (
        await db.query(
          "SELECT a.*,r.operation_name,r.input,s.resolved FROM approvals a JOIN runs r ON r.id=a.run_id JOIN step_runs s ON s.run_id=a.run_id AND s.step_id=a.step_id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT 200",
          [who.workspaceId],
        )
      ).rows,
    };
  });
  server.post<{ Params: { id: string } }>(
    "/api/v1/approvals/:id/decision",
    async (request) => {
      const who = identity(request, ["admin", "reviewer"]),
        body = z
          .object({ decision: z.enum(["APPROVED", "REJECTED"]), reason })
          .parse(request.body);
      return store.decide(who, request.params.id, body.decision, body.reason);
    },
  );
  server.get("/api/v1/events", async (request) => {
    const who = identity(request);
    return {
      items: (
        await db.query(
          "SELECT * FROM events WHERE workspace_id=$1 ORDER BY id DESC LIMIT 200",
          [who.workspaceId],
        )
      ).rows,
    };
  });
  server.get("/api/v1/audit/verify", async (request) => {
    const who = identity(request, ["admin", "reviewer"]);
    const events = (
      await db.query<{
        previous_hash: string;
        hash: string;
        run_id: string | null;
        type: string;
        actor: string;
        data: unknown;
        id: string;
      }>("SELECT * FROM events WHERE workspace_id=$1 ORDER BY id", [
        who.workspaceId,
      ])
    ).rows;
    let previous = "genesis";
    for (const event of events) {
      const expected = hash({
        previous,
        workspaceId: who.workspaceId,
        runId: event.run_id,
        type: event.type,
        actor: event.actor,
        data: event.data,
      });
      if (event.previous_hash !== previous || event.hash !== expected)
        return { valid: false, firstInvalidEvent: event.id };
      previous = event.hash;
    }
    return { valid: true, events: events.length, head: previous };
  });
  server.get("/api/v1/usage", async (request) => {
    const who = identity(request);
    const [runs, usage] = await Promise.all([
      db.query(
        "SELECT status,count(*)::integer AS count FROM runs WHERE workspace_id=$1 GROUP BY status",
        [who.workspaceId],
      ),
      db.query(
        "SELECT count(*)::integer AS attempts,COALESCE(sum(duration_ms),0)::bigint AS duration_ms,COALESCE(sum((usage->>'httpRequests')::integer),0)::bigint AS http_requests,COALESCE(sum((usage->>'browserMs')::integer),0)::bigint AS browser_ms,COALESCE(sum((usage->>'inputTokens')::integer),0)::bigint AS input_tokens,COALESCE(sum((usage->>'outputTokens')::integer),0)::bigint AS output_tokens FROM attempts WHERE workspace_id=$1",
        [who.workspaceId],
      ),
    ]);
    return { runs: runs.rows, usage: usage.rows[0] };
  });
  server.get<{ Params: { id: string } }>(
    "/api/v1/artifacts/:id",
    async (request, reply) => {
      const artifact = await engine.artifacts.read(
        identity(request).workspaceId,
        request.params.id,
      );
      reply.header(
        "Content-Disposition",
        'attachment; filename="' +
          artifact.name.replace(/[^a-zA-Z0-9._-]/g, "_") +
          '"',
      );
      reply.type(artifact.contentType);
      return artifact.body;
    },
  );
  try {
    await access(config.webDir);
    await server.register(staticFiles, { root: config.webDir, prefix: "/" });
    server.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: "Route not found" } })
        : reply.sendFile("index.html"),
    );
  } catch {
    server.get("/", async () => ({
      name: "Agent Operations",
      message: "Run pnpm build to build the dashboard",
      api: "/api/v1/me",
    }));
  }
  server.addHook("onClose", async () => {
    await engine.stop();
    engine.artifacts.close();
  });
  if (options.worker !== false) engine.start();
  return { server, store, engine };
}
