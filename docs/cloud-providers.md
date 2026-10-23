# Agent Operations for cloud providers

Agent Operations can be the basis of a managed service for teams whose agents write to external systems. A customer submits an operation, reviews it when approval is required, and receives either a verified result or an explicit unresolved outcome with evidence to investigate.

The commercial proposal is to license the server for that third-party service and agree on maintenance and support. The current release is suitable for evaluating a technical pilot. This repository does not offer a hosted service, a production SLA or a finished cloud billing system.

## What the customer would buy

A team already running agents may have to build and maintain the same machinery for every write tool: stable business identifiers, exact approvals, result checks, recovery after a timeout, and a screen for a person to handle exceptions.

The proposed paid service takes responsibility for running those configured operations. The customer keeps its agent framework and supplies credentials to the external systems. It submits work through REST or the SDKs; the current MCP bridge runs locally and calls the service's API. People review work in the dashboard.

The value hypothesis is less time implementing recovery and investigating uncertain actions. It must be tested against the customer's existing solution. There are no independent measurements of time saved, production adoption or willingness to pay yet.

An external system needs a reliable way to identify and read back the result. Without that, Agent Operations can record uncertainty and require investigation, but cannot manufacture proof that a write succeeded.

## Start with one operation

The first provider-specific package is **GitHub issues**. It creates an issue in a fixed repository, optionally requires approval, verifies creation, and can wait for completed closure. It checks the exact title, body, author and correlation marker. An ambiguous creation is not automatically replayed.

This is a concrete pilot for agents escalating cases to an engineering team. It is not a claim that issue creation alone supports a large business. Use the pilot to test whether the same action contract is valuable for a customer's higher-volume workflow before adding more integrations.

GitHub.com personal access tokens are supported. GitHub Apps, automatic token refresh and GitHub Enterprise Server are not. Recovery after a lost creation response scans up to 1,000 issues; missing or conflicting evidence remains unresolved. See the full [package contract](packages.md).

The no-account [local supplier demo](quickstart.md) shows the same failure mode with an order fixture. It does not connect to a real commerce provider or place real orders.

## What exists and what the provider must supply

| Area                | Available in v0.2                                                                         | Work needed for a managed offering                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Customer access     | Workspaces, roles, scoped API keys and encrypted connection secrets                       | Customer onboarding, account lifecycle and any SSO/OIDC integration                                                 |
| Execution           | Versioned operations, approvals, business-action ledger, worker recovery and verification | Validate each provider contract and decide which operations customers may install                                   |
| Human review        | Run history, approval screens, audit records and exception resolution                     | Customer support process and ownership of unresolved actions                                                        |
| Deployment          | Container images, PostgreSQL mode and local/S3-compatible artifacts                       | TLS, backups and restore drills, monitoring, infrastructure isolation and capacity testing                          |
| Limits and charging | Daily run and concurrency limits, usage records                                           | A pricing model, billing integration and reconciliation; current usage records are not a billing accuracy guarantee |
| Integrations        | GitHub issues, configurable HTTP/browser steps, SDKs and local stdio MCP                  | Additional provider packages and authentication methods; remote MCP with OAuth is not implemented                   |
| Data lifecycle      | Persisted run, artifact, audit and webhook records                                        | Retention policy, cleanup and tenant offboarding; no automatic retention cleanup is included                        |

Browser contexts are not a complete security boundary for hostile sites. The host must enforce network and process isolation. See [security boundaries](../SECURITY.md) and [deployment](deployment.md).

## A useful pilot result

Choose a bounded workflow, a deployment environment and an expected load. Agree on measurable acceptance criteria before the pilot:

1. Submit the same business case twice and check that it does not produce an independent second write. Conflicting content must be rejected.
2. Lose the creation response after the provider accepts the write. Verify recovery using provider state and confirm that an uncertain write is not blindly replayed.
3. Interrupt the worker, then restart it. Confirm that the operation continues from durable state without losing its approval or action identity.
4. Make verification unavailable, deliver a duplicate event, and return conflicting evidence. Confirm the appropriate waiting or investigation state.
5. Measure operator time per unresolved case, time to verified completion, infrastructure cost and the effort needed to maintain the integration. Compare those with the customer's current implementation at the agreed load.

Local tests and the live GitHub smoke script cover parts of this behavior. The smoke script has not validated inbound delivery from GitHub to a public webhook endpoint. A cloud pilot must test its actual deployment, including access controls, backup restoration and provider outages. Test coverage is not a production capacity or availability guarantee.

## Licensing and commercial terms

The core is under [Elastic License 2.0](../LICENSE), a source-available license. ELv2 restricts offering the software as a hosted or managed service to third parties when they receive access to a substantial set of its features or functionality. Internal use and some forms of embedding are different cases; the [license text](../LICENSE) controls. The SDKs remain Apache-2.0. See [licensing](licensing.md) and the [ELv2 FAQ](https://www.elastic.co/licensing/elastic-license/faq).

A separate agreement with the applicable rights holder would specify permission to operate the managed service, the licensed components, maintenance, support, commercial reporting and fees. A minimum commitment or usage-based fee can be discussed; no pricing, royalty rate, exclusive territory or support obligation is promised here. Third-party dependencies keep their own licenses.

The reason to buy should be useful operation packages and reduced integration work. The license restriction alone does not establish customer demand.

## Discuss a pilot

[Open a cloud pilot inquiry](https://github.com/ArtAndrew/agent-operations/issues/new?template=cloud-pilot.yml) with a public description of the workflow, deployment needs and evaluation criteria. This is an initial technical discussion, not an order form or a commercial license grant. If the project fits, private commercial details can be handled through a mutually agreed channel.

GitHub issues are public. Do not include credentials, customer records, private infrastructure addresses, contracts or confidential pricing information.
