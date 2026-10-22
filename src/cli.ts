#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { database, migrate } from "./db.js";
import { app } from "./app.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { demoProvider, seedDemo } from "./demo.js";
try {
  process.loadEnvFile();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const command = process.argv[2] || "serve";
async function main() {
  if (command === "help" || command === "--help") {
    console.log(
      "Agent Operations\n\nCommands:\n  serve            Start API, dashboard and workers\n  api              Start API and dashboard without workers\n  worker           Start execution workers (requires DATABASE_URL)\n  demo             Start a local workspace and supplier portal\n  migrate          Apply database migrations\n  token            Print the local platform administrator token\n  workspace NAME   Create a workspace and print its initial API key\n\nConfiguration is read from .env and environment variables.",
    );
    return;
  }
  if (
    ![
      "serve",
      "api",
      "worker",
      "demo",
      "migrate",
      "token",
      "workspace",
    ].includes(command)
  )
    throw new Error("Unknown command. Use --help.");
  const settings = await config();
  if (command === "token") {
    console.log(settings.adminToken);
    return;
  }
  if (command === "worker" && !settings.databaseUrl)
    throw new Error(
      "Standalone workers require DATABASE_URL; embedded PostgreSQL supports one process only.",
    );
  const db = await database(settings.databaseUrl, settings.dataDir);
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    await migrate(db);
    const store = new Store(db, settings);
    if (command === "migrate") {
      console.log("Database migrations applied.");
      return;
    }
    if (command === "workspace") {
      const name = process.argv.slice(3).join(" ").trim();
      if (!name) throw new Error("Supply a workspace name.");
      console.log(JSON.stringify(await store.createWorkspace(name), null, 2));
      return;
    }
    if (command === "worker") {
      const engine = new Engine(store);
      cleanup.push(async () => {
        await engine.stop();
        engine.artifacts.close();
      });
      engine.start();
      console.log("Execution workers started.");
    } else {
      let demoToken: string | undefined;
      if (command === "demo") {
        if (!["127.0.0.1", "localhost", "::1"].includes(settings.host))
          throw new Error("Demo mode requires a loopback HOST.");
        const provider = await demoProvider(
          settings.dataDir,
          Number(process.env.DEMO_PROVIDER_PORT || 4301),
        );
        cleanup.push(() => provider.close());
        settings.allowedOrigins.add(provider.listeningOrigin);
        settings.allowPrivateNetwork = true;
        const file = join(settings.dataDir, "demo-workspace.json");
        try {
          demoToken = JSON.parse(await readFile(file, "utf8")).token;
          await store.authenticate(demoToken!);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          const workspace = await store.createWorkspace("Demo workspace");
          demoToken = workspace.token;
          await writeFile(file, JSON.stringify(workspace), { mode: 0o600 });
        }
        await seedDemo(
          store,
          await store.authenticate(demoToken!),
          provider.listeningOrigin,
        );
        console.log("Local supplier portal: " + provider.listeningOrigin);
      }
      const instance = await app(db, settings, {
        worker: command !== "api",
        demoToken,
      });
      cleanup.push(() => instance.server.close());
      await instance.server.listen({
        host: settings.host,
        port: settings.port,
      });
      console.log("Agent Operations: " + instance.server.listeningOrigin);
      console.log(
        command === "demo"
          ? "Use Enter demo on the sign-in page."
          : "Use the token command to retrieve the platform administrator token.",
      );
    }
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    console.log("Stopping workers and closing connections...");
  } finally {
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        console.error(
          "Shutdown error:",
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    }
    await db.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
});
