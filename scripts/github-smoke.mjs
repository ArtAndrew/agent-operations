// Creates and closes validation issues in an explicitly selected PRIVATE repository.
// Never runs in CI by default. No tokens or webhook secrets are printed.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { database, migrate } from "../dist/db.js";
import { config } from "../dist/config.js";
import { app } from "../dist/app.js";
import { Packages } from "../dist/packages.js";
import { ExecutionError } from "../dist/domain.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.env.AOP_GITHUB_TOKEN,
  target = process.env.AOP_GITHUB_SMOKE_REPO;
if (!token || !target || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(target))
  throw new Error(
    "Set AOP_GITHUB_TOKEN and AOP_GITHUB_SMOKE_REPO=owner/private-test-repo. This script creates and closes test issues.",
  );
async function github(path, method = "GET", data) {
  const r = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: "error",
  });
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
  return r.json();
}
const repo = await github("/repos/" + target);
assert.equal(repo.private, true, "Use a private validation repository");
assert.equal(repo.has_issues, true);
const dir = await mkdtemp(join(tmpdir(), "aop-github-smoke-"));
const db = await database();
await migrate(db);
const cfg = await config({
  dataDir: dir,
  port: 4398,
  masterKey: randomBytes(32),
  adminToken: randomBytes(32).toString("hex"),
  allowedOrigins: new Set(["https://api.github.com"]),
});
const instance = await app(db, cfg, { worker: false });
let client;
const created = new Set();
try {
  await instance.server.listen({ host: "127.0.0.1", port: 0 });
  const w = await instance.store.createWorkspace("Private live validation");
  const identity = await instance.store.authenticate(w.token);
  const connection = await instance.store.createConnector(identity, {
    name: "github",
    kind: "http",
    baseUrl: "https://api.github.com",
    secretHeaders: { Authorization: "Bearer " + token },
  });
  const [owner, name] = target.split("/");
  const packages = new Packages(instance.store);
  await packages.install(identity, {
    name: "github-validation",
    connection: connection.id,
    owner,
    repo: name,
    requireApproval: true,
    waitForCompleted: true,
    pollSeconds: 30,
  });
  const operator = await instance.store.createKey(
    identity,
    "MCP operator",
    "operator",
  );
  client = new Client({ name: "aop-live-validation", version: "0.2.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.js"), "mcp"],
      env: {
        PATH: process.env.PATH || "",
        AOP_BASE_URL: instance.server.listeningOrigin,
        AOP_API_KEY: operator.token,
      },
    }),
  );
  const tools = await client.listTools();
  assert(tools.tools.some((t) => t.name === "run_github-validation"));
  for (const lost of [false, true]) {
    const caseId = "validation-" + randomUUID();
    const args = {
      requestKey: caseId,
      input: {
        caseId,
        title: "Agent Operations v0.2 validation",
        body: "Automated private validation of issue creation, recovery, approval and completed closure. No customer data.",
      },
    };
    const response = await client.callTool({
      name: "run_github-validation",
      arguments: args,
    });
    const { run } = JSON.parse(response.content[0].text);
    await instance.engine.tick();
    let detail = await instance.store.detail(w.id, run.id);
    assert.equal(detail.run.status, "WAITING_APPROVAL");
    await instance.store.decide(
      identity,
      detail.approvals[0].id,
      "APPROVED",
      "Approve private validation issue creation",
    );
    const http = instance.engine.executors.network.http.bind(
      instance.engine.executors.network,
    );
    let dispatched = 0;
    instance.engine.executors.network.http = async (url, options) => {
      const result = await http(url, options);
      if (options.method === "POST") {
        dispatched++;
        if (result.body?.number) created.add(result.body.number);
        if (lost)
          throw new ExecutionError(
            "Simulated response loss after GitHub accepted the write",
            true,
            true,
            result.usage,
          );
      }
      return result;
    };
    await instance.engine.tick();
    detail = await instance.store.detail(w.id, run.id);
    for (
      let check = 0;
      !detail.run.outputs.create_issue &&
      detail.run.status === "WAITING_EXTERNAL" &&
      check < 12;
      check++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await instance.store.reconcile(
        identity,
        run.id,
        "Read-only live validation follow-up",
      );
      await instance.engine.tick();
      detail = await instance.store.detail(w.id, run.id);
    }
    assert(
      detail.run.outputs.create_issue,
      "GitHub issue must be independently verified: " +
        JSON.stringify({
          status: detail.run.status,
          error: detail.run.error,
          steps: detail.steps.map((s) => ({
            status: s.status,
            error: s.error,
          })),
          attempts: detail.attempts.map((a) => ({
            status: a.status,
            error: a.error,
          })),
        }),
    );
    const issue = detail.run.outputs.create_issue;
    created.add(issue.number);
    await instance.engine.tick();
    assert.equal(
      (await instance.store.run(w.id, run.id)).status,
      "WAITING_EXTERNAL",
    );
    const repeated = await client.callTool({
      name: "run_github-validation",
      arguments: args,
    });
    assert.equal(JSON.parse(repeated.content[0].text).run.id, run.id);
    await github(`/repos/${target}/issues/${issue.number}`, "PATCH", {
      state: "closed",
      state_reason: "completed",
    });
    await instance.store.reconcile(
      identity,
      run.id,
      "GitHub validation issue closed as completed",
    );
    await instance.engine.tick();
    assert.equal((await instance.store.run(w.id, run.id)).status, "SUCCEEDED");
    assert.equal(dispatched, 1);
    instance.engine.executors.network.http = http;
    const status = await client.callTool({
      name: "operation_status",
      arguments: { runId: run.id },
    });
    assert.equal(JSON.parse(status.content[0].text).run.status, "SUCCEEDED");
  }
  console.log(
    JSON.stringify({
      passed: true,
      repository: target,
      issues: [...created],
      verified: [
        "live GitHub REST",
        "package install",
        "exact approval",
        "MCP stdio client",
        "post-commit lost response",
        "idempotent submission",
        "wait and completed closure",
      ],
      webhook:
        "signature, duplicate and ordering behavior tested locally; live webhook delivery not exercised",
    }),
  );
} finally {
  for (const number of created)
    await github(`/repos/${target}/issues/${number}`, "PATCH", {
      state: "closed",
      state_reason: "completed",
    }).catch(() => {});
  await client?.close();
  await instance.server.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
}
