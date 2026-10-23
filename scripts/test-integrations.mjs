import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dir = await mkdtemp(join(tmpdir(), "aop-integrations-"));
const port = process.env.INTEGRATION_PORT || "4390";
const url = "http://127.0.0.1:" + port;
const server = spawn(process.execPath, ["dist/cli.js", "demo"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: port,
    DEMO_PROVIDER_PORT: String(Number(port) + 1),
    DATA_DIR: dir,
    DATABASE_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (chunk) => {
  logs += chunk;
});
server.stderr.on("data", (chunk) => {
  logs += chunk;
});
const exited = new Promise((resolve) => server.once("exit", resolve));
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error("Demo exited: " + logs);
    try {
      ready = (await fetch(url + "/readyz")).ok;
    } catch {}
    if (ready) break;
    await delay(250);
  }
  if (!ready) throw new Error("Demo did not become ready: " + logs);
  const { token } = JSON.parse(
    await readFile(join(dir, "demo-workspace.json"), "utf8"),
  );
  const test = spawn(
    process.env.PYTHON || "python3",
    ["-m", "unittest", "discover", "-s", "tests/integrations", "-v"],
    {
      env: {
        ...process.env,
        AGENT_OPERATIONS_URL: url,
        AGENT_OPERATIONS_API_KEY: token,
        ANONYMIZED_TELEMETRY: "false",
        BROWSER_USE_LOGGING_LEVEL: "error",
        LANGSMITH_TRACING: "false",
        LANGCHAIN_TRACING_V2: "false",
      },
      stdio: "inherit",
    },
  );
  const code = await new Promise((resolve, reject) => {
    test.once("exit", resolve);
    test.once("error", reject);
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  const forceStop = setTimeout(() => server.kill("SIGKILL"), 10000);
  await exited;
  clearTimeout(forceStop);
  await rm(dir, { recursive: true, force: true });
}
