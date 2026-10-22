import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
export interface Sql {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}
export interface Database extends Sql {
  kind: "postgres" | "embedded";
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function database(
  url?: string,
  dataDir?: string,
): Promise<Database> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 16 });
    const wrap = (client: pg.Pool | pg.PoolClient): Sql => ({
      async query<T>(sql: string, params: unknown[] = []) {
        const r = await client.query(sql, params);
        return { rows: r.rows as T[], rowCount: r.rowCount || 0 };
      },
    });
    return {
      kind: "postgres",
      ...wrap(pool),
      async transaction<T>(fn: (tx: Sql) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(wrap(client));
          await client.query("COMMIT");
          return result;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pglite = new PGlite(dataDir ? join(dataDir, "postgres") : undefined);
  const wrap = (client: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  }): Sql => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await client.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.affectedRows || r.rows.length };
    },
  });
  return {
    kind: "embedded",
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
}
export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    if (db.kind === "postgres")
      await tx.query("SELECT pg_advisory_xact_lock(18520431)");
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const existing = await tx.query(
      "SELECT version FROM schema_migrations WHERE version=1",
    );
    if (!existing.rows.length) {
      for (const statement of migration
        .split("-- statement")
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations(version) VALUES(1)");
    }
    const scheduling = await tx.query(
      "SELECT version FROM schema_migrations WHERE version=2",
    );
    if (!scheduling.rows.length) {
      await tx.query(
        "ALTER TABLE workspaces ADD COLUMN last_claimed_at timestamptz",
      );
      await tx.query("INSERT INTO schema_migrations(version) VALUES(2)");
    }
  });
}
const migration = `
CREATE TABLE workspaces(id text PRIMARY KEY,name text NOT NULL,max_runs_per_day integer NOT NULL DEFAULT 10000,max_concurrent_runs integer NOT NULL DEFAULT 20,two_person_approval boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now())
-- statement
CREATE TABLE api_keys(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),name text NOT NULL,token_hash text NOT NULL UNIQUE,role text NOT NULL CHECK(role IN('admin','operator','reviewer','viewer')),revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())
-- statement
CREATE TABLE connectors(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),name text NOT NULL,kind text NOT NULL,base_url text NOT NULL,headers jsonb NOT NULL DEFAULT '{}',secret_ciphertext text,idempotency_header text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,name))
-- statement
CREATE TABLE operations(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),name text NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,digest text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,name,version))
-- statement
CREATE TABLE runs(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),operation_id text NOT NULL REFERENCES operations(id),operation_name text NOT NULL,version integer NOT NULL,input jsonb NOT NULL,input_hash text NOT NULL,status text NOT NULL,next_step integer NOT NULL DEFAULT 0,outputs jsonb NOT NULL DEFAULT '{}',created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),lease_token text,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),error text,cancel_requested boolean NOT NULL DEFAULT false,idempotency_key text NOT NULL,UNIQUE(workspace_id,idempotency_key))
-- statement
CREATE INDEX runs_claim_idx ON runs(status,available_at,lease_until)
-- statement
CREATE TABLE step_runs(id text PRIMARY KEY,run_id text NOT NULL REFERENCES runs(id),step_id text NOT NULL,status text NOT NULL DEFAULT 'PENDING',attempts integer NOT NULL DEFAULT 0,resolved jsonb,digest text,action_key text,output jsonb,error text,started_at timestamptz,finished_at timestamptz,UNIQUE(run_id,step_id))
-- statement
CREATE TABLE action_ledger(workspace_id text NOT NULL REFERENCES workspaces(id),action_key text NOT NULL,digest text NOT NULL,status text NOT NULL,owner_run_id text NOT NULL REFERENCES runs(id),output jsonb,receipt jsonb,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,action_key))
-- statement
CREATE TABLE approvals(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),run_id text NOT NULL REFERENCES runs(id),step_id text NOT NULL,digest text NOT NULL,requested_by text NOT NULL,status text NOT NULL DEFAULT 'PENDING',decided_by text,reason text,created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,UNIQUE(run_id,step_id,digest))
-- statement
CREATE TABLE events(id bigserial PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),run_id text REFERENCES runs(id),type text NOT NULL,actor text NOT NULL,data jsonb NOT NULL,previous_hash text NOT NULL,hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())
-- statement
CREATE INDEX events_run_idx ON events(run_id,id)
-- statement
CREATE TABLE attempts(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),run_id text NOT NULL REFERENCES runs(id),step_id text NOT NULL,phase text NOT NULL,status text NOT NULL,duration_ms integer NOT NULL,usage jsonb NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now())
-- statement
CREATE TABLE artifacts(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),run_id text NOT NULL REFERENCES runs(id),step_id text NOT NULL,name text NOT NULL,storage_key text NOT NULL,content_type text NOT NULL,size_bytes integer NOT NULL,sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())
`;
