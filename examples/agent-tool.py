# SPDX-License-Identifier: Apache-2.0
"""A framework-neutral tool that an external Python agent can call."""
import os
from agent_operations import AgentOperations

client = AgentOperations(
    os.environ["AGENT_OPERATIONS_URL"],
    os.environ["AGENT_OPERATIONS_API_KEY"],
)


def place_supplier_order(purchase_request_id: str, item: str, quantity: int) -> dict:
    """Submit an approved, verifiable supplier action using a durable request ID."""
    submitted = client.submit(
        "reviewed-order",
        {"id": purchase_request_id, "item": item, "quantity": quantity},
        idempotency_key="supplier-purchase:" + purchase_request_id,
    )
    result = client.wait(submitted["run"]["id"], timeout=60)
    return {
        "run_id": result["run"]["id"],
        "status": result["run"]["status"],
        "outputs": result["run"]["outputs"],
    }


if __name__ == "__main__":
    print(place_supplier_order("example-purchase-42", "Notebook", 2))
