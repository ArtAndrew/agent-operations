# Bind human approval to the action that will execute

"Approve this agent" leaves an important question unanswered: which action did the person actually review?

A reviewer may see two notebooks for one supplier account while the worker later resolves a different quantity or uses rotated credentials. Recording a generic approval flag is insufficient if the action can change between review and dispatch.

## Resolve first, review second

Agent Operations persists the resolved step before asking for approval. That snapshot includes the action parameters and connection binding. A digest binds the decision to the snapshot; before dispatch, the worker checks that the approval applies to that exact action.

The connection binding includes its identity, target and credential fingerprint without revealing the credential. If that binding changes after preparation, the old approval is not silently carried over to the new target or account.

The audit record preserves the decision and reason. The operator can inspect the resolved action alongside the eventual verified result.

## Try it

Start the [demo](../quickstart.md). Create a `browser-order` with:

```json
{ "id": "article-approval-001", "item": "Notebook", "quantity": 2 }
```

The run waits before browser dispatch. Open **Review approvals**, inspect the target and resolved form fields, and record an approval with a reason. The worker then performs the browser action and verifies the supplier result. Rejecting a pending approval stops that run.

In your own agent, return `WAITING_APPROVAL` to the application instead of generating a replacement request with a different ID. The [LangGraph example](../../examples/integrations/langgraph_order.py) demonstrates this branch without a model call.

## Scope the guarantee carefully

Approval binding does not prove that the reviewer understood the request or that a website will interpret it correctly. Verification remains a separate contract. Nor does it control actions that bypass this server.

Optional separation between the submitting and reviewing API-key identities is not identity-provider-backed separation between two people. A platform administrator can provision keys. The current release does not include SSO.

Use this mechanism for an explicit operation boundary: what may execute, under which connection, after which review. See [approval and recovery semantics](../execution.md), [security boundaries](../../SECURITY.md), and the [credential-rotation and approval tests](../../tests/engine.test.ts).
