# Deployment

## Local mode

Without `DATABASE_URL`, the server uses embedded PostgreSQL through PGlite. Its files and local artifacts live under `DATA_DIR` (default `.data`). Use one server process for an embedded database. For multiple API or worker processes, use network PostgreSQL.

`serve` runs the API, dashboard and workers together. `api` runs only the API and dashboard. `worker` runs standalone workers and requires `DATABASE_URL`.

## Docker Compose

```sh
node scripts/setup-env.mjs
# Edit ALLOWED_ORIGINS and PUBLIC_ORIGIN in .env.
docker compose up --build -d
docker compose exec api node dist/cli.js workspace "My workspace"
```

The workspace command prints its initial key once. Store it securely and use it to open the dashboard. The supplied Compose configuration exposes the API on host loopback only. Place a TLS reverse proxy in front of it for remote access and set `PUBLIC_ORIGIN` to the exact public HTTPS origin.

PostgreSQL and artifacts use persistent named volumes. Never remove those volumes as part of a routine update.

The worker image includes Chromium and runs as a non-root user. Browser traffic still needs infrastructure-level egress controls: see [security boundaries](../SECURITY.md). Do not attach browser workers to networks containing metadata endpoints, internal control planes or unrelated customer services.

## Configuration

| Variable                                     | Purpose                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `HOST`, `PORT`                               | Listener address; local defaults `127.0.0.1:4300`.                                                               |
| `DATABASE_URL`                               | PostgreSQL connection string; omit for local embedded mode.                                                      |
| `DATA_DIR`                                   | Embedded database, local secrets and local artifact directory.                                                   |
| `MASTER_KEY`                                 | 64 hexadecimal characters used for AES-256-GCM connector encryption and session signing. Required in production. |
| `ADMIN_TOKEN`                                | Platform administrator bearer token. Required in production.                                                     |
| `PUBLIC_ORIGIN`                              | Canonical dashboard origin behind a proxy; controls browser origin checks and secure cookies.                    |
| `ALLOWED_ORIGINS`                            | Comma-separated exact provider origins including non-default ports.                                              |
| `ALLOW_PRIVATE_NETWORK`                      | Explicit development escape hatch for private IPs and HTTP. Default false.                                       |
| `WORKER_CONCURRENCY`                         | Concurrent execution loops per worker process, 1–64. Default 4.                                                  |
| `S3_BUCKET`                                  | Enable S3-compatible artifact storage.                                                                           |
| `S3_ENDPOINT`                                | Optional custom object-store endpoint.                                                                           |
| `AWS_REGION`                                 | Object-store region, default `us-east-1`.                                                                        |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Optional object-store credentials; the AWS SDK credential chain is also available.                               |
| `CHROMIUM_EXECUTABLE`                        | Optional explicit browser executable path. Normally use the Playwright-managed version.                          |

The local demo additionally supports `DEMO_PROVIDER_PORT`. It is a development facility and must remain loopback-only.

Use the same master key across API and worker processes. Back it up separately from PostgreSQL; encrypted connection secrets cannot be recovered without it. Rotating this master key requires decrypting and re-encrypting existing records in a controlled migration. Replacing it without migration breaks existing connections and invalidates sessions.

## Scaling and operations

Workers claim runs with PostgreSQL row locks and leases. Workspace concurrency limits apply across workers. Scale the worker service independently from the API, while sharing the database, master key, allowed-origin policy and artifact storage.

Use an object store when workers run on different hosts. With local artifacts, every API and worker process must mount the same artifact directory. The application does not make an S3 bucket public; artifact downloads are authorized through the API.

Migrations run on startup. Network PostgreSQL migration execution uses an advisory lock. Back up before upgrading. The current schema does not implement automatic data retention or tenant deletion; plan storage and retention explicitly.

`/healthz` checks process liveness. `/readyz` checks database access. Worker errors are written to stderr. Monitor process restarts, database health, long-lived queued runs, `NEEDS_ATTENTION` counts, provider failures and browser resource use.

SIGTERM/SIGINT stop workers and close connections. An interrupted write is verified before any further automatic decision where possible; unresolved effects remain visible for recovery. Abrupt termination is handled through lease expiry.

## Backups

Back up PostgreSQL, artifacts and the master key as a consistent operational set. For embedded mode, stop the process before copying its database directory. For network PostgreSQL, use the database's backup and recovery facilities. Test restoration into an isolated environment with outbound writes disabled before resuming workers.

The repository does not include a multi-region failover system or a production availability guarantee. Establish workload-specific capacity, recovery objectives and provider contracts before exposing a managed service.
