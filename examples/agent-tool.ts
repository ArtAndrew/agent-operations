// SPDX-License-Identifier: Apache-2.0
import { AgentOperations } from "../sdk/typescript/src/index.js";
const client = new AgentOperations({
  baseUrl: process.env.AGENT_OPERATIONS_URL || "http://127.0.0.1:4300",
  apiKey: process.env.AGENT_OPERATIONS_API_KEY || "",
});
/** Register this function as a tool in the agent framework of your choice. */
export async function placeSupplierOrder(
  purchaseRequestId: string,
  item: string,
  quantity: number,
) {
  const { run } = await client.submit(
    "reviewed-order",
    { id: purchaseRequestId, item, quantity },
    { idempotencyKey: "supplier-purchase:" + purchaseRequestId },
  );
  const result = await client.wait(run.id, { timeoutMs: 60000 });
  return {
    runId: run.id,
    status: result.run.status,
    outputs: result.run.outputs,
  };
}
