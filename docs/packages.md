# Operation packages

A package installs an immutable, versioned operation with provider-specific execution and verification rules. Administrators configure the repository and approval policy. Agents supply case details through the existing API, SDKs or MCP tools.

## GitHub issues 0.2.0

The first package creates an issue in a fixed GitHub.com repository. It can finish after independent creation verification, or wait until the same issue is closed with `state_reason: completed`. Closing as `not_planned` does not satisfy that contract. This is an issue workflow, not a claim that the underlying customer problem has been independently solved.

1. Add `https://api.github.com` to the server's `ALLOWED_ORIGINS` and restart the server.
2. Open **Packages → Install GitHub package** as a workspace administrator.
3. Add an HTTP GitHub connection using a fine-grained personal access token limited to the selected repository. It needs Issues read/write and Metadata read permissions. The token is encrypted at rest and not returned by the connection listing.
4. Enter the repository owner and name. Use **Check connection** to verify the account, repository and enabled issues. This read-only check does not prove write permission.
5. Choose whether creation requires approval and whether the operation should wait for completed closure. Install the package.
6. Choose **Run operation**, supply a stable case ID, title and description, then submit. This creates a real issue after any required approval. Use a dedicated private repository for validation.

GitHub App installation tokens, GitHub Enterprise Server, automatic token refresh, assignees and labels are not supported in this version. The `/user` identity check requires a personal access token. Repository administrators must separately enable issues and grant access.

### Recovery contract

- A stable case ID is scoped to the workspace, connection and repository. The business ledger prevents an independent dispatch for the same prepared action. Different content under the same identity is rejected.
- The issue body includes an opaque correlation marker. Verification checks the repository URL, issue author, exact title and body. Do not edit the generated title, body or marker while the operation is pending. Edits require operator investigation.
- A known issue number is checked directly. When the creation response was lost, recovery scans repository issues without relying on GitHub's search index, up to 1,000 records. A missing result, scan limit or conflicting matches never authorizes another creation request.
- GitHub creation is never automatically replayed after an uncertain dispatch. A timeout might have happened before or after GitHub accepted the issue. If no matching issue can be established, the run remains uncertain and eventually needs attention.
- Creation recovery checks every 60 seconds by default, for up to one hour. Waiting for completed closure defaults to seven days. API configuration accepts `pollSeconds` from 30–3,600 and `maxWaitHours` from 1–720 for closure waits.
- A verified creation receipt survives subsequent waiting, cancellation or failure. Cancelling a read-only closure wait does not delete or close the issue. An unresolved creation cannot be hidden by cancellation.
- Terminal success records the state observed at verification time. The service does not keep watching for later reopening after the run finishes.

## Webhooks

Polling works without webhooks. On installation the server returns an endpoint `/hooks/github/<installation-id>` and a secret displayed once. Configure a repository webhook with **application/json**, **Issues** events and this secret. GitHub requires a reachable HTTPS endpoint; a localhost URL alone is not sufficient.

The handler verifies the HMAC-SHA256 signature over the original request bytes, validates the configured repository and durably deduplicates delivery IDs. Events only wake pending reads. They cannot directly declare success, approve a write or replace provider state. Repeated and out-of-order events are safe because the next check reads GitHub again. Polling covers missed deliveries and a wake-up arriving during active execution.

Delivery IDs and audit records are retained in the database. Operators are responsible for capacity and retention planning. This release has no automatic retention cleanup.

## API

- `GET /api/v1/packages`: catalog and this workspace's installations; no secrets.
- `POST /api/v1/packages/github-issues/check`: administrator-only read access check.
- `POST /api/v1/packages/github-issues/install`: administrator-only installation, returning the pinned operation and one-time webhook secret.

Check/install configuration:

```json
{
  "name": "github-case",
  "connection": "github-connection-id",
  "owner": "your-organization",
  "repo": "your-repository",
  "requireApproval": true,
  "waitForCompleted": true,
  "pollSeconds": 60,
  "maxWaitHours": 168
}
```

Operation input:

```json
{
  "caseId": "support-1042",
  "title": "Investigate reported error",
  "body": "Reproduction details and expected result."
}
```

Installations cannot overwrite existing operation names. To change package settings, install under a new name. Existing runs retain their version. The action ledger still detects conflicting reuse of a case in the same connection/repository. Credential rotation remains subject to the original connection-binding rules; an already prepared action is not silently rebound to a new credential. Resolve uncertain outcomes using independent evidence.

## Live validation

After building, run `node scripts/github-smoke.mjs` with `AOP_GITHUB_TOKEN` and `AOP_GITHUB_SMOKE_REPO=owner/private-test-repository`. The script refuses public repositories. It creates and closes two test issues, exercises approval, the real MCP stdio client, normal creation, simulated loss of the response after a real GitHub write, and completed closure. Secrets are not printed; the temporary local database is removed. It does not delete the GitHub issues.

Local tests additionally cover signature validation, duplicate/stale webhook events, access errors, deadline exhaustion, restart recovery and tenant boundaries. The smoke script does not claim to test delivery from GitHub to a public webhook endpoint.
