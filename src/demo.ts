import Fastify from "fastify";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Identity } from "./domain.js";

const Order = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  item: z.string().min(1).max(200),
  quantity: z.coerce.number().int().positive().max(10000),
  mode: z.enum(["normal", "lose-response", "unverifiable"]).default("normal"),
});
type OrderRecord = z.infer<typeof Order> & {
  status: "created";
  createdAt: string;
};
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function page(title: string, body: string) {
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' +
    escape(title) +
    "</title><style>body{font:16px system-ui;background:#f4f6f9;color:#19263d;margin:40px auto;max-width:720px;padding:24px}article{background:white;padding:32px;border:1px solid #dce2ec;border-radius:16px}h1{font-size:28px}label{display:block;margin:18px 0}input,select,button{font:inherit;padding:10px;border:1px solid #c6cfdd;border-radius:6px}input,select{display:block;width:94%;margin-top:8px}button{background:#244bdb;color:white;cursor:pointer}small{color:#5c6b82}a{color:#244bdb}table{width:100%;text-align:left}td,th{padding:12px;border-bottom:1px solid #eee}</style><article><small>AGENT OPERATIONS · LOCAL TEST PROVIDER</small><h1>" +
    escape(title) +
    "</h1>" +
    body +
    "</article></html>"
  );
}
export async function demoProvider(dataDir: string, port = 4301) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "demo-provider.json");
  let records: Record<string, OrderRecord> = {};
  try {
    records = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let pending = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(records);
    pending = pending.then(async () => {
      await writeFile(file + ".tmp", snapshot, { mode: 0o600 });
      await rename(file + ".tmp", file);
    });
    return pending;
  };
  const server = Fastify({ bodyLimit: 100000 });
  server.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  server.setErrorHandler((error, _request, reply) =>
    reply.status(error instanceof z.ZodError ? 400 : 500).send({
      error: error instanceof z.ZodError ? "Invalid order" : "Provider error",
    }),
  );
  server.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    if (
      request.headers.origin &&
      request.headers.origin !== server.listeningOrigin
    )
      return reply.status(403).send({ error: "Cross-origin request denied" });
  });
  async function create(raw: unknown) {
    const order = Order.parse(raw),
      old = records[order.id];
    if (old) {
      if (old.item !== order.item || old.quantity !== order.quantity)
        throw new Error("Order ID conflict");
      return old;
    }
    const record: OrderRecord = {
      ...order,
      status: "created",
      createdAt: new Date().toISOString(),
    };
    records[order.id] = record;
    await persist();
    return record;
  }
  server.get("/healthz", async () => ({
    status: "ok",
    provider: "local-demo",
  }));
  server.post("/orders", async (request, reply) => {
    const record = await create(request.body);
    if (record.mode === "lose-response") {
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    return record;
  });
  server.get<{ Params: { id: string } }>(
    "/orders/:id",
    async (request, reply) => {
      const record = records[request.params.id];
      if (!record) return reply.status(404).send({ error: "Order not found" });
      if (record.mode === "unverifiable")
        return reply
          .status(503)
          .send({ error: "Simulated verification outage" });
      return record;
    },
  );
  server.post("/v1/chat/completions", async (request) => {
    const body = request.body as { messages?: Array<{ content: string }> };
    const prompt = body.messages?.at(-1)?.content || "";
    return {
      id: "local-demo-completion",
      model: "demo-json",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              summary: "Local demo analysis: " + prompt.slice(0, 160),
              requiresReview: true,
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: 32,
      },
    };
  });
  server.get("/", async (_request, reply) =>
    reply.type("text/html").send(
      page(
        "Supplier portal",
        '<p>This local provider stores real demo orders on disk. No external purchases are made.</p><p><a href="/portal/new">Create order</a></p><table><thead><tr><th>Order</th><th>Item</th><th>Mode</th></tr></thead><tbody>' +
          Object.values(records)
            .map(
              (r) =>
                '<tr><td><a href="/portal/orders/' +
                escape(r.id) +
                '">' +
                escape(r.id) +
                "</a></td><td>" +
                escape(r.item) +
                "</td><td>" +
                escape(r.mode) +
                "</td></tr>",
            )
            .join("") +
          "</tbody></table>",
      ),
    ),
  );
  server.get("/portal/new", async (_request, reply) =>
    reply
      .type("text/html")
      .send(
        page(
          "Create order",
          '<form method="post" action="/portal/orders"><label>Order ID<input name="id" required pattern="[a-zA-Z0-9_-]{1,80}"></label><label>Item<input name="item" required></label><label>Quantity<input name="quantity" type="number" min="1" value="1"></label><label>Fault simulation<select name="mode"><option value="normal">Normal</option><option value="unverifiable">Verification outage</option></select></label><button type="submit">Create order</button></form>',
        ),
      ),
  );
  server.post("/portal/orders", async (request, reply) => {
    const order = await create(request.body);
    return reply.redirect("/portal/orders/" + encodeURIComponent(order.id));
  });
  server.get<{ Params: { id: string } }>(
    "/portal/orders/:id",
    async (request, reply) => {
      const order = records[request.params.id];
      if (!order)
        return reply
          .status(404)
          .type("text/html")
          .send(page("Not found", "<p>Order does not exist.</p>"));
      return reply
        .type("text/html")
        .send(
          page(
            "Order receipt",
            '<dl><dt>Order ID</dt><dd id="order-id">' +
              escape(order.id) +
              '</dd><dt>Status</dt><dd id="order-status">' +
              escape(order.status) +
              "</dd><dt>Item</dt><dd>" +
              escape(order.item) +
              "</dd><dt>Quantity</dt><dd>" +
              order.quantity +
              "</dd></dl><p>Verification mode: " +
              escape(order.mode) +
              "</p>" +
              (order.mode === "unverifiable"
                ? '<form method="post" action="/portal/orders/' +
                  escape(order.id) +
                  '/restore"><button>Restore verification endpoint</button></form>'
                : "") +
              '<p><a href="/">All orders</a></p>',
          ),
        );
    },
  );
  server.post<{ Params: { id: string } }>(
    "/portal/orders/:id/restore",
    async (request, reply) => {
      const order = records[request.params.id];
      if (!order) return reply.status(404).send({ error: "Not found" });
      order.mode = "normal";
      await persist();
      return reply.redirect("/portal/orders/" + encodeURIComponent(order.id));
    },
  );
  await server.listen({ host: "127.0.0.1", port });
  return server;
}

export const demoInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "item", "quantity"],
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" },
    item: { type: "string", minLength: 1 },
    quantity: { type: "integer", minimum: 1, maximum: 10000 },
    mode: { type: "string", enum: ["normal", "lose-response", "unverifiable"] },
  },
};
export async function seedDemo(
  store: Store,
  identity: Identity,
  origin: string,
) {
  const connections = [
    {
      name: "supplier-api",
      kind: "http" as const,
      baseUrl: origin,
      idempotencyHeader: "Idempotency-Key",
    },
    { name: "supplier-browser", kind: "browser" as const, baseUrl: origin },
    { name: "demo-model", kind: "model" as const, baseUrl: origin + "/v1/" },
  ];
  for (const connection of connections) {
    try {
      await store.connector(identity.workspaceId, connection.name);
    } catch {
      await store.createConnector(identity, connection);
    }
  }
  const verify = {
    kind: "http",
    connection: "supplier-api",
    request: { path: "/orders/{{ input.id }}" },
    assertions: [
      { path: "id", operator: "equals", value: "{{ input.id }}" },
      { path: "item", operator: "equals", value: "{{ input.item }}" },
      { path: "quantity", operator: "equals", value: "{{ input.quantity }}" },
      { path: "status", operator: "equals", value: "created" },
    ],
  };
  const api = {
    id: "create",
    title: "Create supplier order",
    kind: "http",
    connection: "supplier-api",
    effect: "write",
    businessKey: "{{ input.id }}",
    request: { method: "POST", path: "/orders", body: "{{ input }}" },
    verify,
  };
  const definitions = [
    {
      name: "create-order",
      description:
        "Create an order through the supplier API, then independently verify it. Try mode lose-response or unverifiable to exercise recovery.",
      inputSchema: demoInputSchema,
      steps: [api],
    },
    {
      name: "reviewed-order",
      description:
        "Analyze an order with the local demo model, review its exact action, then create and verify the order. The demo model is a deterministic fixture, not a paid LLM.",
      inputSchema: demoInputSchema,
      steps: [
        {
          id: "analyze",
          kind: "agent",
          connection: "demo-model",
          model: "demo-json",
          instructions:
            "Summarize the order and identify whether a human should review it.",
          prompt:
            "Order {{ input.id }}: {{ input.quantity }} units of {{ input.item }}",
          outputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["summary", "requiresReview"],
            properties: {
              summary: { type: "string" },
              requiresReview: { type: "boolean" },
            },
          },
        },
        { ...api, approval: true },
      ],
    },
    {
      name: "browser-order",
      description:
        "Fill the supplier portal in an isolated browser, capture a receipt screenshot, then verify the order through the API.",
      inputSchema: demoInputSchema,
      steps: [
        {
          id: "create",
          title: "Submit supplier portal form",
          kind: "browser",
          connection: "supplier-browser",
          effect: "write",
          businessKey: "{{ input.id }}",
          approval: true,
          actions: [
            { action: "goto", path: "/portal/new" },
            { action: "fill", selector: "[name=id]", value: "{{ input.id }}" },
            {
              action: "fill",
              selector: "[name=item]",
              value: "{{ input.item }}",
            },
            {
              action: "fill",
              selector: "[name=quantity]",
              value: "{{ input.quantity }}",
            },
            { action: "click", selector: "button[type=submit]" },
            { action: "wait", selector: "#order-status" },
          ],
          extract: { id: "#order-id", status: "#order-status" },
          verify,
        },
      ],
    },
  ];
  for (const definition of definitions) {
    try {
      await store.operation(identity.workspaceId, definition.name);
    } catch {
      await store.register(identity, definition);
    }
  }
}
