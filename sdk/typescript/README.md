# Agent Operations TypeScript SDK

Apache-2.0. This client has no runtime dependencies and uses the standard Fetch API.

Install the archive directly from [GitHub Release](https://github.com/ArtAndrew/agent-operations/releases/tag/v0.2.0):

```sh
npm install https://github.com/ArtAndrew/agent-operations/releases/download/v0.2.0/agent-operations-sdk-0.2.0.tgz
```

Alternatively, build from the repository with `pnpm build` and import `sdk/typescript/dist/index.js`. The package is distributed through GitHub; it does not require publication to the npm registry.

```ts
import { AgentOperations } from "@agent-operations/sdk";

const client = new AgentOperations({
  baseUrl: process.env.AGENT_OPERATIONS_URL!,
  apiKey: process.env.AGENT_OPERATIONS_API_KEY!,
});
const { run } = await client.submit(
  "create-order",
  { id: "order-42", item: "Notebook", quantity: 2 },
  { idempotencyKey: "purchase-request-42" },
);
const result = await client.wait(run.id, { timeoutMs: 60_000 });
console.log(result.run.status);
```

Reuse the same idempotency key when retrying a submission after a network error. The client does not silently retry writes.

`wait` returns for terminal states and, by default, `WAITING_APPROVAL` or `NEEDS_ATTENTION`. Set `stopOnDecision: false` to keep polling across human decisions. An AbortSignal stops the local HTTP request or polling; it does not cancel the durable run.

Methods: `me`, `publish`, `operation`, `operations`, `submit`, `run`, `runs`, `wait`, `cancel`, `reconcile`, `resolve`, `approvals`, `decide`, `connect`, `rotateCredentials`, `usage`, `verifyAudit`, and `tool`.

`tool(name)` returns a JSON Schema function-tool description. Your agent integration is responsible for mapping the model's invocation to `submit`, assigning a durable business/request identity, and handling approval or exception states. A tool schema alone does not execute an operation.
