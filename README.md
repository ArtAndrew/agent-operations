# Agent Operations

**Approvals and verified results for agents that change external systems.**

An agent creates an issue or submits an order, but the response never arrives. Retrying might create a duplicate. Stopping leaves someone to investigate. Agent Operations keeps a record of the intended action, checks the external system, and either confirms the result or puts the unresolved action in front of an operator.

[![CI](https://github.com/ArtAndrew/agent-operations/actions/workflows/ci.yml/badge.svg)](https://github.com/ArtAndrew/agent-operations/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ArtAndrew/agent-operations)](https://github.com/ArtAndrew/agent-operations/releases)
[![License: ELv2](https://img.shields.io/badge/core-ELv2-blue)](LICENSE)

[Try the local demo](#try-it-locally) · [Use with your agent](#use-it-with-your-existing-agent) · [For cloud providers](docs/cloud-providers.md) · [First-run feedback](https://github.com/ArtAndrew/agent-operations/issues/new?template=first-run.yml)

## Who it is for

- **Teams connecting agents to business systems:** give an agent a named operation with a fixed destination, input schema, approval policy and result check.
- **Platform engineers:** keep action identity and recovery state outside the agent's conversation, so a restarted agent can look up existing work.
- **People reviewing automated work:** see the proposed action, approve its exact contents, and investigate uncertain outcomes in one dashboard.

The aim is to reduce duplicate writes and manual investigation. This is an early release; there is no measured cost-saving or production-scale claim. If your agent only reads data, or your application already handles these contracts, a separate service may add little value.

The server and dashboard are source-available under [Elastic License 2.0](LICENSE). The [TypeScript](sdk/typescript) and [Python](sdk/python) SDKs are Apache-2.0. A managed service that exposes substantial functionality to third-party customers requires a [separate commercial agreement](docs/licensing.md).

## A failure you can reproduce

![Recorded local demo: prepare an order, lose the response, inspect the verified result](docs/images/recovery-demo.gif)

These selected frames from a real local run are held for readability. The supplier fixture persists an order, intentionally drops the response, and exposes a separate lookup endpoint. It makes no real purchase and uses no paid model. [Reproduce it yourself](docs/quickstart.md).

## A real integration: GitHub issues

The first provider package creates issues in a configured GitHub.com repository:

1. Your application supplies a stable case ID; an agent supplies the proposed title and description.
2. If approval is required, a person reviews the exact action before it is sent.
3. Agent Operations creates the issue and reads GitHub to verify it. If the creation response is lost, it searches for the matching issue instead of blindly creating another.
4. The run can finish after verified creation, or wait until GitHub reports that issue as closed and completed. Unresolved or conflicting results need investigation.

The case ID is separate from the conversation and run ID. Reusing it with conflicting content is rejected. Verification checks the issue's identity and contents; completed closure proves GitHub's recorded state, not that the underlying business problem was solved.

[Package setup and limits](docs/packages.md) · [MCP connection](docs/mcp.md) · [Deep Agents example](examples/integrations/deepagents_github.py) · [Release notes](docs/releases/v0.2.0.md)

The existing supplier demo remains local and requires no GitHub account. The GitHub package uses a real repository and creates real issues after any required approval. Use a private validation repository first.

## How it fits with other projects

Durable state, retries and human approval are established features in agent and workflow systems. The distinction here is the combination of an external action contract, provider-specific verification, and an operator interface.

| Project                                                                                                                                             | What it already provides                                                                                              | Where Agent Operations fits                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/persistence) / [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) | Agent execution, persistent state and human intervention; Deep Agents adds planning, files and subagents.             | A tool can submit an installed operation while the agent keeps its planning and context. The operation owns business identity, approval and external-result verification.                   |
| [browser-use](https://docs.browser-use.com/open-source/customize/tools/add)                                                                         | Browser agents and custom tools, including API calls and human input.                                                 | A custom tool can delegate a predefined browser or API operation. Only actions routed through that tool receive these checks.                                                               |
| [Temporal](https://docs.temporal.io/activities)                                                                                                     | Durable workflows and activities with retry policies; application authors implement external actions and idempotency. | A more specific application for configured actions, their verification rules and human review. You can build similar contracts on Temporal; this project aims to reduce that assembly work. |

The practical question is how much integration and recovery work an installed operation saves. Today there is one provider-specific package, GitHub issues, plus configurable HTTP/browser operations and the local supplier fixture. Broader provider coverage and lower operating cost still need to be demonstrated.

## For cloud providers

The proposed service is **managed execution and review of agent actions**. Your customers connect their systems, install operations, and submit work through the API or SDKs. They use the dashboard to approve actions and resolve uncertain results. Agents can also connect through the current local MCP bridge.

You host the service and manage the customer relationship, infrastructure and billing. A commercial agreement can grant the right to offer Agent Operations to third parties and define support and maintenance responsibilities. The starting point is a technical pilot around one workflow, with agreed acceptance criteria before a customer rollout.

[Cloud pilot scope, responsibilities and commercial licensing](docs/cloud-providers.md) · [Discuss a pilot](https://github.com/ArtAndrew/agent-operations/issues/new?template=cloud-pilot.yml)

## Try it locally

Requires Node.js 22.12 or later and pnpm 11.25.0.

```sh
git clone https://github.com/ArtAndrew/agent-operations.git
cd agent-operations
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium --only-shell
pnpm demo
```

Open **http://127.0.0.1:4300** and choose **Enter demo workspace**. The supplier portal runs at **http://127.0.0.1:4301**.

The demo stores orders on disk and uses a deterministic model fixture. It does not contact a paid model or place external orders.

Try these operations:

| Operation        | What happens                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `create-order`   | Calls the supplier API and verifies the stored order independently.                                      |
| `reviewed-order` | Produces structured demo analysis, waits for a human decision, then creates the order.                   |
| `browser-order`  | Fills a supplier form in an isolated browser, captures a receipt screenshot and verifies the API result. |

Example input:

```json
{ "id": "order-1001", "item": "Notebook", "quantity": 2, "mode": "normal" }
```

For `create-order`, change `mode` to `lose-response` to commit the order but lose the response. The worker checks the external result and completes without sending the write again. Use `unverifiable` to simulate an unavailable verification endpoint. Restore it in the supplier portal, then choose **Check again** on the run.

For the exact released source, run `git checkout v0.2.0` after cloning. [GitHub Release](https://github.com/ArtAndrew/agent-operations/releases/tag/v0.2.0) also provides Linux Docker images and installable Python/TypeScript SDK archives. See [prebuilt installation](docs/prebuilt.md).

## Use it with your existing agent

| Example                                                   | What it proves                                                                          | Model key required?                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| [Python recovery](examples/integrations/recover_order.py) | Lost-response recovery and repeated submission returning the same run                   | No                                        |
| [LangGraph](examples/integrations/langgraph_order.py)     | A real graph node submits an operation and routes approval or uncertainty to the caller | No                                        |
| [browser-use](examples/integrations/browser_use_order.py) | A registered custom tool requests an approved browser operation                         | No                                        |
| [Deep Agents](examples/integrations/deepagents_github.py) | A real agent tool submits a GitHub operation; the host application owns the case ID     | For a live model; the test uses a fixture |

Agents that support stdio MCP can also use the [MCP bridge](docs/mcp.md) to submit installed operations and read their status. The bridge cannot approve actions or administer the workspace.

These examples are tested against pinned libraries. The browser-use example exercises its tool registry and the server's real Chromium operation; it does not claim to test an autonomous model-driven browsing session. [Setup and boundaries](examples/integrations/README.md).

Use Agent Operations when you need an explicit contract around an external action: its business identity, exact approval, verification and recovery. Your existing agent can retain planning and model selection. Operations are currently sequential; see the boundaries below before adopting it.

## What is included

- Immutable operation versions, JSON Schema input contracts and stable request idempotency.
- HTTP, isolated-browser, structured-model and data-transformation steps.
- A business-action ledger shared across runs, with conflicting-payload detection.
- PostgreSQL leases, worker heartbeats, durable state and recovery after a worker stops.
- Approvals tied to the resolved action digest; optional separation by API-key identity.
- Read-only reconciliation and evidence-backed manual exception resolution.
- Workspace isolation, roles, encrypted connector secrets, daily run limits and concurrency limits.
- A dashboard for runs, definitions, approvals, connections, usage, keys and audit records.
- Local or S3-compatible artifact storage, including browser receipt screenshots.
- TypeScript and dependency-free Python SDKs.
- A local embedded PostgreSQL mode and a network PostgreSQL mode for multiple processes.

Agent Operations does **not** promise universal exactly-once delivery to third-party services. A network timeout cannot reveal whether a remote write committed. [Execution semantics](docs/execution.md) explains what the engine can prove, when it will retry and when it requires evidence.

## Connect your own agents

An agent built with your preferred framework can submit a named operation through the SDK or REST API. The operation owns the external action, approval and verification contract. Existing agents can continue planning and interpreting results outside this server.

```ts
import { AgentOperations } from "./sdk/typescript/dist/index.js";

const client = new AgentOperations({
  baseUrl: "http://127.0.0.1:4300",
  apiKey: process.env.AGENT_OPERATIONS_API_KEY!,
});

const { run } = await client.submit(
  "create-order",
  { id: "order-1001", item: "Notebook", quantity: 2 },
  { idempotencyKey: "purchase-request-1001" },
);
const result = await client.wait(run.id);
console.log(result.run.status, result.run.outputs);
```

`wait` returns when a run finishes **or** needs a human decision. Timing out or stopping the client does not cancel the server-side operation.

## Run without demo data

```sh
cp .env.example .env
pnpm build
pnpm cli serve
```

Retrieve the local platform token with `pnpm cli token`. Sign in to create a workspace, then save its initial workspace key. Alternatively, run `pnpm cli workspace "My team"`. Locally generated secrets live in `.data/local-secrets.json`; this directory is ignored by Git.

Before creating external connections, configure their exact origins in `ALLOWED_ORIGINS`. Private destinations and plain HTTP require explicit development configuration. Never use the demo login on a publicly accessible deployment.

## Documentation

- [Ten-minute first-run walkthrough](docs/quickstart.md)
- [Prebuilt Docker images and SDK archives](docs/prebuilt.md)
- [Why retrying an agent action can duplicate an order](docs/articles/lost-response.md)
- [Bind approval to the action that will execute](docs/articles/exact-approval.md)
- [Verify browser actions after a failure](docs/articles/browser-verification.md)
- [Operation definitions and examples](docs/operations.md)
- [Installed packages and GitHub recovery limits](docs/packages.md)
- [MCP connection](docs/mcp.md)
- [Execution, retries and recovery](docs/execution.md)
- [Deployment and configuration](docs/deployment.md)
- [REST API and access roles](docs/api.md)
- [Security boundaries](SECURITY.md)
- [TypeScript SDK](sdk/typescript/README.md) and [Python SDK](sdk/python/README.md)
- [Licensing](docs/licensing.md) and [third-party notices](THIRD_PARTY_NOTICES.md)
- [Cloud provider pilots](docs/cloud-providers.md)

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
pnpm test:e2e
```

Set `TEST_DATABASE_URL` to run the integration suite against PostgreSQL instead of embedded PostgreSQL. Tests create and remove isolated schemas. Browser tests require the Playwright Chromium installation.

The test suite exercises lost responses after commit, expired leases, duplicate business actions, approval binding, input validation, tenant isolation, credential handling, both SDKs and browser workflows. See [contributing](CONTRIBUTING.md) for development conventions.

## Current boundaries

Operations are ordered step sequences. Arbitrary Python or shell code is not executed inside the server. Browser recipes use explicit selectors and actions; the built-in model step produces schema-validated JSON and does not autonomously invoke tools. External agent frameworks can choose and submit operations through the SDK.

The current release does not include SSO, a payment processor, a visual workflow builder, multi-region coordination or a hosted service. MCP is stdio only. The GitHub package uses personal access tokens; GitHub App authentication and automatic token refresh are not implemented. Production deployments need their own TLS, backups, network isolation, monitoring and capacity validation.

## Try one workflow and tell us what happened

We are looking for early users who operate agents that change external systems. Run one demo, then [share a first-run report](https://github.com/ArtAndrew/agent-operations/issues/new?template=first-run.yml): what you tried, where you got stuck, and which real action you want to protect. Redact credentials and customer data. [Questions and use cases](https://github.com/ArtAndrew/agent-operations/discussions) are welcome.

There is no adoption or production-performance claim in this release. Feedback from an independent installation is more useful than a synthetic benchmark alone.
