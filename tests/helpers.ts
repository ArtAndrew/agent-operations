import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database, migrate, type Database } from "../src/db.js";
import type { Config } from "../src/config.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";

export async function fixture(origins: string[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-operations-test-"));
  let db: Database,
    cleanup: () => Promise<void> = async () => {};
  if (process.env.TEST_DATABASE_URL) {
    const admin = await database(process.env.TEST_DATABASE_URL);
    const schema = "test_" + randomUUID().replaceAll("-", "");
    await admin.query("CREATE SCHEMA " + schema);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", "-csearch_path=" + schema);
    db = await database(url.href);
    cleanup = async () => {
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.close();
    };
  } else db = await database();
  await migrate(db);
  const config: Config = {
    host: "127.0.0.1",
    port: 4300,
    dataDir,
    masterKey: randomBytes(32),
    adminToken: randomBytes(32).toString("hex"),
    allowedOrigins: new Set(origins),
    allowPrivateNetwork: true,
    concurrency: 4,
    leaseMs: 30000,
    pollMs: 50,
    webDir: join(dataDir, "missing-web"),
  };
  const store = new Store(db, config),
    engine = new Engine(store);
  async function workspace() {
    const w = await store.createWorkspace("Test workspace");
    return { ...w, identity: await store.authenticate(w.token) };
  }
  return {
    db,
    config,
    store,
    engine,
    workspace,
    async close() {
      await engine.stop();
      await db.close();
      await cleanup();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function writeOperation(
  name = "create-order",
  extra: Record<string, unknown> = {},
) {
  return {
    name,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, mode: { type: "string" } },
    },
    steps: [
      {
        id: "create",
        kind: "http",
        connection: "provider",
        effect: "write",
        businessKey: "{{ input.id }}",
        request: { method: "POST", path: "/orders", body: "{{ input }}" },
        verify: {
          kind: "http",
          connection: "provider",
          request: { path: "/orders/{{ input.id }}" },
          assertions: [
            { path: "id", operator: "equals", value: "{{ input.id }}" },
            { path: "status", operator: "equals", value: "created" },
          ],
        },
        ...extra,
      },
    ],
  };
}
