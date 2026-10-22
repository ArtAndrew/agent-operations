import { it, expect } from "vitest";
import Fastify from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture } from "./helpers.js";
it("exits cleanly instead of leaving workers running when the listener cannot start", async () => {
  const f = await fixture(),
    occupied = Fastify();
  await occupied.listen({ host: "127.0.0.1", port: 0 });
  try {
    const port = new URL(occupied.listeningOrigin).port;
    let failure: unknown;
    try {
      await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "serve"],
        {
          timeout: 15000,
          env: {
            ...process.env,
            NODE_ENV: "test",
            HOST: "127.0.0.1",
            PORT: port,
            DATA_DIR: f.config.dataDir,
            DATABASE_URL: "",
            MASTER_KEY: f.config.masterKey.toString("hex"),
            ADMIN_TOKEN: f.config.adminToken,
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 1, killed: false });
    expect((failure as { stderr: string }).stderr).toContain("EADDRINUSE");
  } finally {
    await occupied.close();
    await f.close();
  }
}, 20000);
