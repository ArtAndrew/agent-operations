# SPDX-License-Identifier: Apache-2.0
"""Reproduce a committed order whose HTTP response is lost."""
import json
import os
import sys
from agent_operations import AgentOperations


def recover(client: AgentOperations, request_id: str) -> dict:
    inputs = {"id": request_id, "item": "Notebook", "quantity": 2, "mode": "lose-response"}
    first = client.submit("create-order", inputs, idempotency_key="recovery-demo:" + request_id)
    result = client.wait(first["run"]["id"], timeout=60)
    repeated = client.submit("create-order", inputs, idempotency_key="recovery-demo:" + request_id)
    if first["run"]["id"] != repeated["run"]["id"]:
        raise AssertionError("Repeated submission did not return the original run")
    return {"run_id": result["run"]["id"], "status": result["run"]["status"],
            "same_run_on_repeat": True, "steps": result["steps"]}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python examples/integrations/recover_order.py REQUEST_ID")
    client = AgentOperations(os.environ.get("AGENT_OPERATIONS_URL", "http://127.0.0.1:4300"),
                             os.environ["AGENT_OPERATIONS_API_KEY"])
    print(json.dumps(recover(client, sys.argv[1]), indent=2))
