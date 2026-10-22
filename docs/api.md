# REST API

All workspace endpoints use the prefix `/api/v1` and require `Authorization: Bearer <workspace-key>`. Browser sessions use a signed HTTP-only cookie. Errors have the form `{"error":{"code":"...","message":"..."}}`; validation errors may include details.

## Access roles

| Role       | Access                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `viewer`   | Read runs, definitions, connections without secrets, approvals, events, usage and artifacts.          |
| `operator` | Viewer access plus submit, cancel and reconcile.                                                      |
| `reviewer` | Viewer access plus approve/reject, reconcile, manually resolve and verify the audit chain.            |
| `admin`    | All workspace functions, including publishing definitions, connection credentials, keys and policies. |

The platform token creates and lists workspaces. It does not act as a workspace key on execution endpoints.

## Endpoints

| Method / path                                            | Purpose                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| GET `/me`                                                | Current identity, workspace settings and allowed origins.                             |
| GET / POST `/workspaces`                                 | List/create workspaces; platform token only. POST body: `{"name":"Team"}`.            |
| PATCH `/workspace`                                       | Set `name`, `maxRunsPerDay`, `maxConcurrentRuns`, `twoPersonApproval`.                |
| GET / POST `/keys`                                       | List/create keys. POST body: `{"name":"Agent","role":"operator"}`.                    |
| DELETE `/keys/:id`                                       | Revoke a key. The current identity cannot revoke itself.                              |
| GET / POST `/connectors`                                 | List/create provider connections.                                                     |
| PUT `/connectors/:id/credentials`                        | Replace encrypted secret headers: `{"secretHeaders":{"Authorization":"Bearer ..."}}`. |
| GET / POST `/operations`                                 | List latest definitions or publish a version.                                         |
| GET `/operations/:name?version=1`                        | Read a version; omit the query to read the latest.                                    |
| GET `/runs?status=SUCCEEDED&limit=50&before=<timestamp>` | List runs, newest first; limit 1–200.                                                 |
| POST `/runs`                                             | Submit a run; requires `Idempotency-Key`.                                             |
| GET `/runs/:id`                                          | Run, steps, approvals, attempts, events and artifact metadata.                        |
| POST `/runs/:id/cancel`                                  | Request cancellation: `{"reason":"No longer needed"}`.                                |
| POST `/runs/:id/reconcile`                               | Recheck an uncertain external result: `{"reason":"Provider is available"}`.           |
| POST `/runs/:id/resolve`                                 | Record an operator decision with evidence.                                            |
| GET `/approvals`                                         | Latest 200 approval records.                                                          |
| POST `/approvals/:id/decision`                           | `{"decision":"APPROVED","reason":"Reviewed payload"}`; or `REJECTED`.                 |
| GET `/events`                                            | Latest 200 workspace events.                                                          |
| GET `/audit/verify`                                      | Validate the retained event hash chain.                                               |
| GET `/usage`                                             | Run counts and observed executor usage.                                               |
| GET `/artifacts/:id`                                     | Download an authorized artifact.                                                      |

### Submit an operation

```sh
curl -X POST http://127.0.0.1:4300/api/v1/runs \
  -H "Authorization: Bearer $AGENT_OPERATIONS_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: purchase-request-42" \
  -d '{"operation":"create-order","input":{"id":"order-42","item":"Notebook","quantity":2}}'
```

The response is `{"run":{...},"replayed":false}` with HTTP 201, or the original run with `replayed:true` and HTTP 200 for a duplicate request. Use an explicit `version` to pin the requested definition.

### Create a connection

```json
{
  "name": "supplier-api",
  "kind": "http",
  "baseUrl": "https://supplier.example/",
  "secretHeaders": { "Authorization": "Bearer YOUR_PROVIDER_KEY" },
  "idempotencyHeader": "Idempotency-Key"
}
```

Only configure an idempotency header when the provider actually supports it. The origin must already be in the server's allowlist.

### Resolve uncertainty

```json
{
  "outcome": "confirmed",
  "reason": "Provider support confirmed the original write",
  "evidence": "Provider ticket CASE-42 and receipt ORDER-42",
  "output": { "id": "order-42", "status": "created" }
}
```

The alternate outcome is `failed`. It closes the action and prevents automatic replay under the same business key. This endpoint is an operator assertion, not automatic external verification.

## Session and health endpoints

`POST /api/session` accepts `{"token":"..."}`; `DELETE /api/session` signs out. Browser mutations reject mismatched request origins. Configure `PUBLIC_ORIGIN` when TLS terminates at a proxy.

`GET /api/config` exposes the product version and whether local demo login is enabled. `GET /healthz` and `GET /readyz` are unauthenticated health checks.

The default application request limit is 300 requests/minute per observed client IP, with a stricter login limit. When deploying behind a proxy, plan shared-IP rate limiting at the ingress; this server does not trust arbitrary forwarded headers.
