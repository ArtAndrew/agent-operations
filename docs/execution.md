# Execution and recovery

## Two kinds of identity

The submission `Idempotency-Key` identifies a request within a workspace. Repeating the same operation and input with that key returns the original run. Explicitly specifying a different version or changing the input is a conflict. Omitting a version on a repeated submission reuses the original run even if a newer operation version exists.

For a write step, `businessKey` identifies the real-world action. Its ledger key combines the workspace, operation name, step ID and resolved business key. It is shared across runs and operation versions. The ledger also records the resolved step digest; reusing a business key with a different resolved payload is a conflict.

Choose a business key from a durable business identifier, such as a purchase request ID. Do not generate a new business key just because a request timed out.

## Lifecycle

```text
QUEUED → RUNNING → SUCCEEDED
            ├── WAITING_APPROVAL → QUEUED
            ├── RETRYING → RUNNING
            ├── NEEDS_ATTENTION → reconciliation / operator resolution
            ├── FAILED
            └── CANCELLED
```

Each step persists its resolved input and digest before dispatch. The run uses a lease token; a worker that loses its lease cannot commit a later state transition. Heartbeats extend active leases. Independent processes coordinate through network PostgreSQL.

The business-action ledger is claimed transactionally before the external call. Another run with the same action waits for the owner, reuses a confirmed result, or enters recovery. It cannot independently dispatch while an active owner holds the action.

## Recovery rules

| Situation                                                              | Behavior                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Read-only step fails transiently                                       | Retry within the configured attempt limit.                                  |
| Write responds successfully                                            | Run the independent verification contract.                                  |
| Write response is lost                                                 | Attempt read-only verification before deciding what happened.               |
| Verification confirms the intended result                              | Record success and the verification output.                                 |
| Provider confirms absence, and its connector has an idempotency header | A retry may use the same provider idempotency key within the attempt limit. |
| Worker stops after dispatch                                            | The next worker verifies; it does not blindly resend the write.             |
| Outcome remains uncertain                                              | Set `NEEDS_ATTENTION` and stop automatic writes.                            |
| Same business key, different resolved action                           | Reject with an action conflict.                                             |

A provider's idempotency header must actually implement the contract. Adding a header to an arbitrary API does not make that API idempotent. Understand the provider's retention period and behavior before enabling automatic write retries.

An HTTP 404 is only a useful absence signal when the endpoint and consistency model make it reliable. Eventual consistency, delayed commits or ambiguous identifiers can defeat a naive verifier. Use a stable business lookup and assertions that check identity **and** the fields that establish the intended outcome.

## Verification

HTTP verifiers can issue GET or HEAD requests. Browser verifiers navigate to a receipt page and extract explicit selectors. Browser verification blocks non-GET/HEAD requests and WebSockets. The external service must still honor read semantics for those methods.

Assertions support equality, existence, containment and numeric comparisons. The verified response becomes the step output for subsequent steps. A mismatch is uncertain for a write; it is not proof that the action did not happen.

Verification is not a general proof of business correctness. A poorly chosen lookup, assertion or business key can confirm the wrong resource. Operation authors own the verification contract.

## Approval and manual resolution

Approval records bind a reviewer decision to the persisted resolved-step digest. The worker checks the decision before dispatch. Rejection stops the run. With separate-identity policy enabled, the submitter's API key cannot approve or manually resolve its own run. This is API-key separation, not an identity-provider-backed two-person guarantee.

The snapshot also binds connection identity, target and credential fingerprint without exposing the secret. Rotating credentials after preparation prevents dispatch under the previous approval. A verifier whose bound credentials change cannot silently confirm a result under a different account. Re-submit for fresh review before dispatch, or resolve an already dispatched action using independent evidence.

`reconcile` rechecks external state without replaying the mutation. If an operator has independent evidence, `resolve` records the outcome, reason, evidence reference and output. A confirmed manual outcome resumes subsequent steps; a failed outcome closes the business action and blocks replay under that same key.

Do not mark a run confirmed merely to unblock it. The supplied output becomes input to later steps.

## Cancellation and limits

Cancellation is immediate before dispatch. An in-flight action must be verified before cancellation takes effect. An uncertain write must be reconciled or manually resolved; hiding it as cancelled would lose an unresolved external effect.

Attempt counters record the requests and browser/model usage observed by workers. Abrupt process termination can leave an attempt unrecorded or prevent final usage from being reported. These counters support operations and capacity planning; they are not an exactly-once billing ledger.

The audit chain detects altered retained events when checked against its own stored hashes. A database administrator can rewrite the full chain, including its head. Export and externally anchor chain heads if independent tamper evidence is required.
