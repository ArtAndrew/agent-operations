import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { fixture } from "./helpers.js";
import { demoProvider, seedDemo } from "../src/demo.js";
const suite = process.env.BROWSER_TESTS === "1" ? describe : describe.skip;
suite("real browser and model operation integration", () => {
  let f: Awaited<ReturnType<typeof fixture>>,
    provider: Awaited<ReturnType<typeof demoProvider>>,
    workspace: Awaited<
      ReturnType<Awaited<ReturnType<typeof fixture>>["workspace"]>
    >;
  beforeAll(async () => {
    f = await fixture();
    provider = await demoProvider(f.config.dataDir, 0);
    f.config.allowedOrigins.add(provider.listeningOrigin);
    workspace = await f.workspace();
    await seedDemo(f.store, workspace.identity, provider.listeningOrigin);
  });
  afterAll(async () => {
    await f?.close();
    await provider?.close();
  });
  async function finish(id: string) {
    for (let i = 0; i < 10; i++) {
      const run = await f.store.run(workspace.id, id);
      if (
        ["SUCCEEDED", "FAILED", "NEEDS_ATTENTION", "WAITING_APPROVAL"].includes(
          run.status,
        )
      )
        return run;
      await f.engine.tick();
    }
    throw new Error("Run did not settle");
  }
  it("fills a real browser form, approves the payload, verifies the API and stores a screenshot", async () => {
    const { run } = await f.store.submit(
      workspace.identity,
      "browser-order",
      { id: "browser-test", item: "Notebook", quantity: 2 },
      "browser-test",
    );
    expect((await finish(run.id)).status).toBe("WAITING_APPROVAL");
    const approval = (await f.store.detail(workspace.id, run.id))
      .approvals[0] as { id: string };
    await f.store.decide(
      workspace.identity,
      approval.id,
      "APPROVED",
      "Reviewed exact browser inputs",
    );
    const result = await finish(run.id);
    expect(result.status, result.error || "").toBe("SUCCEEDED");
    expect(result.outputs.create).toMatchObject({
      id: "browser-test",
      quantity: 2,
      status: "created",
    });
    const artifact = (await f.store.detail(workspace.id, run.id))
      .artifacts[0] as { id: string; sha256: string };
    const read = await f.engine.artifacts.read(workspace.id, artifact.id);
    expect(read.contentType).toBe("image/png");
    expect(read.body.subarray(1, 4).toString()).toBe("PNG");
    expect(createHash("sha256").update(read.body).digest("hex")).toBe(
      artifact.sha256,
    );
  }, 60000);
  it("runs a structured model step before an approved external action", async () => {
    const { run } = await f.store.submit(
      workspace.identity,
      "reviewed-order",
      { id: "model-test", item: "Keyboard", quantity: 1 },
      "model-test",
    );
    expect((await finish(run.id)).status).toBe("WAITING_APPROVAL");
    const detail = await f.store.detail(workspace.id, run.id);
    expect(detail.run.outputs.analyze).toMatchObject({ requiresReview: true });
    expect(
      detail.attempts.some(
        (a) => (a.usage as { inputTokens: number }).inputTokens > 0,
      ),
    ).toBe(true);
    await f.store.decide(
      workspace.identity,
      String(detail.approvals[0]!.id),
      "APPROVED",
      "Analysis and supplier action reviewed",
    );
    expect((await finish(run.id)).status).toBe("SUCCEEDED");
  });
});
