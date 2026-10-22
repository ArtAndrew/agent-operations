import { beforeAll, afterAll, it, expect } from "vitest";
import { fixture } from "./helpers.js";
import { app } from "../src/app.js";
import {
  AgentOperations,
  AgentOperationsError,
} from "../sdk/typescript/src/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
let f: Awaited<ReturnType<typeof fixture>>,
  a: Awaited<ReturnType<typeof app>>,
  client: AgentOperations,
  key: string;
beforeAll(async () => {
  f = await fixture();
  const w = await f.workspace();
  key = w.token;
  a = await app(f.db, f.config);
  await a.server.listen({ host: "127.0.0.1", port: 0 });
  client = new AgentOperations({
    baseUrl: a.server.listeningOrigin,
    apiKey: key,
  });
});
afterAll(async () => {
  await a?.server.close();
  await f?.close();
});
it("uses the TypeScript SDK to publish, submit, deduplicate and wait against the server", async () => {
  await client.publish({
    name: "sdk-echo",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
    },
    steps: [
      {
        id: "result",
        kind: "transform",
        value: { received: "{{ input.message }}" },
      },
    ],
  });
  const submission = await client.submit(
    "sdk-echo",
    { message: "Hello SDK" },
    { idempotencyKey: "typescript-1" },
  );
  const result = await client.wait(submission.run.id, {
    pollMs: 25,
    timeoutMs: 10000,
  });
  expect(result.run.status).toBe("SUCCEEDED");
  expect(result.run.outputs.result).toEqual({ received: "Hello SDK" });
  expect(
    (
      await client.submit(
        "sdk-echo",
        { message: "Hello SDK" },
        { idempotencyKey: "typescript-1" },
      )
    ).replayed,
  ).toBe(true);
  expect((await client.tool("sdk-echo")).function.parameters.required).toEqual([
    "message",
  ]);
  await expect(
    client.submit("sdk-echo", {}, { idempotencyKey: "invalid" }),
  ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  expect((await client.verifyAudit()).valid).toBe(true);
});
it("uses the Python SDK to run a real operation against the same server", async () => {
  const python = process.env.PYTHON || "python3";
  const code = [
    "import os",
    "from agent_operations import AgentOperations",
    'client = AgentOperations(os.environ["SDK_BASE_URL"], os.environ["SDK_API_KEY"])',
    'client.publish({"name":"python-echo","steps":[{"id":"result","kind":"transform","value":"{{ input }}"}]})',
    'submitted = client.submit("python-echo", {"hello":"python"}, idempotency_key="python-1")',
    'result = client.wait(submitted["run"]["id"], timeout=10, poll_interval=0.05)',
    'assert result["run"]["status"] == "SUCCEEDED", result',
    'assert result["run"]["outputs"]["result"] == {"hello":"python"}, result',
    'assert client.verify_audit()["valid"]',
    'print("Python SDK integration passed")',
  ].join("\n");
  const result = await promisify(execFile)(python, ["-c", code], {
    env: {
      ...process.env,
      PYTHONPATH: process.cwd() + "/sdk/python/src",
      SDK_BASE_URL: a.server.listeningOrigin,
      SDK_API_KEY: key,
    },
  });
  expect(result.stdout).toContain("Python SDK integration passed");
});
it("reports typed errors and aborts polling without cancelling the server run", async () => {
  const wrong = new AgentOperations({
    baseUrl: a.server.listeningOrigin,
    apiKey: "not-a-valid-key",
  });
  await expect(wrong.me()).rejects.toBeInstanceOf(AgentOperationsError);
  const signal = AbortSignal.abort(new Error("Caller stopped waiting"));
  await expect(client.wait("irrelevant", { signal })).rejects.toThrow(
    "Caller stopped waiting",
  );
});
