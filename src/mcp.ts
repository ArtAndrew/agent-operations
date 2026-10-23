import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export function createMcpServer(baseUrl: string, apiKey: string) {
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("MCP requires HTTPS or a loopback HTTP server URL");
  if (!apiKey) throw new Error("Set AOP_API_KEY to a workspace operator key");
  const request = async (path: string, body?: unknown, key?: string) => {
    const r = await fetch(url.href.replace(/\/$/, "") + "/api/v1" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const data = await r.json();
    if (!r.ok)
      throw new Error(data.error?.message || "Agent Operations request failed");
    return data;
  };
  const installed = async () =>
    (await request("/packages")).items as Array<{
      operation_name: string;
      operation_version: number;
    }>;
  const server = new Server(
    { name: "agent-operations", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    for (const item of await installed()) {
      const op = await request(
        `/operations/${encodeURIComponent(item.operation_name)}?version=${item.operation_version}`,
      );
      tools.push({
        name: "run_" + item.operation_name,
        description:
          op.definition.description +
          " Returns a tracked run, not a completion claim. Reuse requestKey for the same request.",
        inputSchema: {
          type: "object" as const,
          additionalProperties: false,
          required: ["requestKey", "input"],
          properties: {
            requestKey: { type: "string", minLength: 1, maxLength: 200 },
            input: op.definition.inputSchema,
          },
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      });
    }
    tools.push({
      name: "operation_status",
      description:
        "Read verified state, approvals and external evidence for a run. WAITING_EXTERNAL is not success.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
        required: ["runId"],
        properties: { runId: { type: "string" } },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      let result;
      if (req.params.name === "operation_status") {
        const args = z
          .object({ runId: z.string().uuid() })
          .strict()
          .parse(req.params.arguments);
        const detail = await request("/runs/" + args.runId);
        result = {
          run: detail.run,
          steps: detail.steps,
          approvals: detail.approvals,
        };
      } else {
        const op = (await installed()).find(
          (i) => "run_" + i.operation_name === req.params.name,
        );
        if (!op) throw new Error("Unknown installed operation");
        const args = z
          .object({
            requestKey: z.string().min(1).max(200),
            input: z.record(z.string(), z.unknown()),
          })
          .strict()
          .parse(req.params.arguments);
        result = await request(
          "/runs",
          {
            operation: op.operation_name,
            version: op.operation_version,
            input: args.input,
          },
          args.requestKey,
        );
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              e instanceof z.ZodError
                ? "Invalid tool arguments"
                : e instanceof Error
                  ? e.message
                  : "Operation request failed",
          },
        ],
      };
    }
  });
  return server;
}
export async function runMcp() {
  await createMcpServer(
    process.env.AOP_BASE_URL || "http://127.0.0.1:4300",
    process.env.AOP_API_KEY || "",
  ).connect(new StdioServerTransport());
}
