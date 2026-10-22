# Why retrying an agent action can duplicate an order

An agent calls `POST /orders`. The supplier commits the order. Before the response arrives, the connection closes. The agent sees a network error, but the supplier has already changed state.

Repeating the POST is a new risk, not a diagnosis. A workflow checkpoint can remember that a tool was running without establishing whether the remote service committed its side effect. A model's explanation cannot establish that fact either.

## Give the request and the business action separate identities

Agent Operations uses two keys. A request `Idempotency-Key` makes repeated submission return the same run. A write step's `businessKey` identifies the business action across runs, within its workspace, operation and step. A changed resolved payload under the same business identity is a conflict.

For a purchase request, choose the ID assigned by the application. Keep it stable across model retries. A freshly generated UUID on every retry defeats this protection.

## Check before deciding to write again

Before dispatch, the engine stores the resolved action and claims its ledger entry. After dispatch, a verification contract reads the supplier's state. A matching order ID alone is weak evidence: check the intended item, quantity and final status as well.

If those assertions match, the run can succeed even when its POST response was lost. If the outcome cannot be established, the run becomes `NEEDS_ATTENTION`. A read-only reconciliation can later check it again. The engine does not label uncertainty as a confirmed failure.

## Reproduce the failure

Start the [local demo](../quickstart.md), choose `create-order`, and submit:

```json
{
  "id": "article-response-001",
  "item": "Notebook",
  "quantity": 2,
  "mode": "lose-response"
}
```

Expected: one dispatch attempt, `SUCCEEDED`, and a matching order in the supplier portal. The fixture persists the order before destroying the HTTP response. The worker's separate GET confirms the saved result. The [Python example](../../examples/integrations/recover_order.py) also repeats submission and checks that the run ID remains unchanged.

## The provider contract still matters

The demo supplier deduplicates order IDs, too. This is a controlled failure experiment, not a universal exactly-once guarantee. A provider's idempotency header must have real semantics, including a retention period. An eventually consistent lookup can report absence even after a write committed. A verifier must account for that provider behavior.

The useful contract is explicit: persist what was attempted, prevent conflicting local ownership, check independent evidence, and surface uncertainty. Read the [complete execution rules](../execution.md), [engine tests](../../tests/engine.test.ts), and [implementation](../../src/engine.ts) before adapting the pattern to a real service.
