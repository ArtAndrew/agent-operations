import { it, expect } from "vitest";
import Fastify from "fastify";
import { fixture } from "./helpers.js";
import { Artifacts } from "../src/artifacts.js";
import { createHash } from "node:crypto";
it("round-trips private artifacts through an S3-compatible endpoint", async () => {
  const objects = new Map<string, Buffer>(),
    server = Fastify();
  server.removeAllContentTypeParsers();
  server.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  server.put("/*", async (request, reply) => {
    objects.set(request.url.split("?")[0]!, request.body as Buffer);
    reply.header("ETag", '"test-etag"');
    return "";
  });
  server.get("/*", async (request, reply) => {
    const data = objects.get(request.url.split("?")[0]!);
    return data
      ? reply.type("application/octet-stream").send(data)
      : reply.status(404).send();
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const previousAccess = process.env.AWS_ACCESS_KEY_ID,
    previousSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = "local-test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "local-test-secret";
  const f = await fixture();
  f.config.s3 = {
    bucket: "test-artifacts",
    region: "us-east-1",
    endpoint: server.listeningOrigin,
  };
  const storage = new Artifacts(f.db, f.config);
  try {
    const w = await f.workspace();
    await f.store.register(w.identity, {
      name: "artifact",
      steps: [{ id: "result", kind: "transform", value: 1 }],
    });
    const { run } = await f.store.submit(
      w.identity,
      "artifact",
      {},
      "artifact",
    );
    const content = Buffer.from("A real receipt payload"),
      id = await storage.save(w.id, run.id, "result", {
        name: "receipt.txt",
        content,
        contentType: "text/plain",
      });
    const result = await storage.read(w.id, id);
    expect(result.body).toEqual(content);
    expect(result.contentType).toBe("text/plain");
    const metadata = (
      await f.db.query<{ sha256: string }>(
        "SELECT sha256 FROM artifacts WHERE id=$1",
        [id],
      )
    ).rows[0]!;
    expect(metadata.sha256).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
    expect([...objects.keys()][0]).toBe(
      "/test-artifacts/" + w.id + "/" + run.id + "/" + id,
    );
    const stranger = await f.workspace();
    await expect(storage.read(stranger.id, id)).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    storage.close();
    await f.close();
    await server.close();
    if (previousAccess === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previousAccess;
    if (previousSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousSecret;
  }
});
