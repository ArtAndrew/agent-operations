import { it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { app } from "../src/app.js";
it("serves the built UI without exposing files outside its directory or bypassing API authentication", async () => {
  const f = await fixture();
  f.config.webDir = join(f.config.dataDir, "public");
  await mkdir(f.config.webDir);
  await writeFile(
    join(f.config.webDir, "index.html"),
    '<html lang="en">Agent Operations test dashboard</html>',
  );
  await writeFile(
    join(f.config.dataDir, "private.txt"),
    "private-file-must-not-leak",
  );
  const server = await app(f.db, f.config, { worker: false });
  try {
    const index = await server.server.inject("/");
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("test dashboard");
    expect((await server.server.inject("/api/v1/me")).statusCode).toBe(401);
    for (const path of [
      "/%2e%2e/private.txt",
      "/..%2fprivate.txt",
      "/%61pi/v1/me",
      "/api%2fv1/me",
      "/api/v1/%6de",
    ]) {
      const response = await server.server.inject(path);
      expect(response.body).not.toContain("private-file-must-not-leak");
      expect(response.body).not.toContain('"workspaceId"');
    }
  } finally {
    await server.server.close();
    await f.close();
  }
});
it("honors an explicit HTTPS public origin behind a reverse proxy", async () => {
  const f = await fixture();
  f.config.publicOrigin = "https://operations.example.com";
  const w = await f.workspace(),
    server = await app(f.db, f.config, { worker: false });
  try {
    const allowed = await server.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: f.config.publicOrigin },
      payload: { token: w.token },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["set-cookie"]).toContain("Secure");
    const denied = await server.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "https://attacker.example" },
      payload: { token: w.token },
    });
    expect(denied.statusCode).toBe(403);
  } finally {
    await server.server.close();
    await f.close();
  }
});
