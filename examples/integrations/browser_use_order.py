# SPDX-License-Identifier: Apache-2.0
"""Register a browser-use tool without giving the model control of request IDs."""
import asyncio
import json
import os
import sys

from agent_operations import AgentOperations
from browser_use import ActionResult, Tools


def build_tools(client: AgentOperations, request_id: str) -> Tools:
    if not request_id:
        raise ValueError("The application must supply a stable request ID")
    tools = Tools()

    @tools.action(description="Submit the supplier order for human approval and verified browser execution. Stop when review or reconciliation is required.")
    async def submit_supplier_order(item: str, quantity: int) -> ActionResult:
        def submit_and_wait():
            submitted = client.submit(
                "browser-order", {"id": request_id, "item": item, "quantity": quantity},
                idempotency_key="browser-use-order:" + request_id,
            )
            result = client.wait(submitted["run"]["id"], timeout=60)
            return {"run_id": result["run"]["id"], "status": result["run"]["status"],
                    "outputs": result["run"]["outputs"],
                    "dashboard_url": client.base_url.removesuffix("/api/v1") + "/#/runs/" + result["run"]["id"]}

        result = await asyncio.to_thread(submit_and_wait)
        # End this agent turn. The application/operator decides when to resume.
        return ActionResult(is_done=True, success=result["status"] == "SUCCEEDED",
                            extracted_content=json.dumps(result))

    return tools


async def demo(request_id: str):
    client = AgentOperations(os.environ.get("AGENT_OPERATIONS_URL", "http://127.0.0.1:4300"),
                             os.environ["AGENT_OPERATIONS_API_KEY"])
    tools = build_tools(client, request_id)
    # Exercise the actual browser-use registry. No model or model API key is used.
    result = await tools.registry.execute_action("submit_supplier_order", {"item": "Notebook", "quantity": 2})
    print(result.extracted_content)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python examples/integrations/browser_use_order.py REQUEST_ID")
    asyncio.run(demo(sys.argv[1]))
