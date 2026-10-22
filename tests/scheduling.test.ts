import { it, expect } from "vitest";
import { fixture } from "./helpers.js";
it("rotates ready workspaces and respects capacity without starving another tenant", async () => {
  const f = await fixture();
  try {
    const a = await f.workspace(),
      b = await f.workspace();
    for (const w of [a, b])
      await f.store.register(w.identity, {
        name: "work",
        steps: [{ id: "result", kind: "transform", value: 1 }],
      });
    const a1 = await f.store.submit(a.identity, "work", {}, "a1"),
      a2 = await f.store.submit(a.identity, "work", {}, "a2"),
      b1 = await f.store.submit(b.identity, "work", {}, "b1");
    const first = await f.engine.claim(),
      second = await f.engine.claim();
    expect(first?.id).toBe(a1.run.id);
    expect(second?.id).toBe(b1.run.id);
    await f.db.query(
      "UPDATE workspaces SET max_concurrent_runs=1 WHERE id=$1",
      [a.id],
    );
    expect(await f.engine.claim()).toBeUndefined();
    await f.engine.process(first!);
    await f.engine.process(second!);
    await f.engine.tick();
    expect((await f.store.run(a.id, a2.run.id)).status).toBe("SUCCEEDED");
  } finally {
    await f.close();
  }
});
