# SPDX-License-Identifier: Apache-2.0
"""A real LangGraph node delegates an external action to Agent Operations."""
import json
import os
import sys
from typing import TypedDict

from agent_operations import AgentOperations
from langgraph.graph import END, START, StateGraph


class OrderState(TypedDict, total=False):
    request_id: str
    item: str
    quantity: int
    mode: str
    run_id: str
    status: str
    next_action: str
    outputs: dict


def build_graph(client: AgentOperations, operation: str = "reviewed-order"):
    def submit(state: OrderState):
        # The application supplies this ID. A model retry must not replace it.
        request_id = state["request_id"]
        result = client.submit(
            operation,
            {"id": request_id, "item": state["item"], "quantity": state["quantity"],
             "mode": state.get("mode", "normal")},
            idempotency_key="langgraph-order:" + request_id,
        )
        return {"run_id": result["run"]["id"]}

    def observe(state: OrderState):
        result = client.wait(state["run_id"], timeout=60)
        status = result["run"]["status"]
        return {"status": status, "outputs": result["run"]["outputs"]}

    def route(state: OrderState):
        return {
            "SUCCEEDED": "complete", "WAITING_APPROVAL": "review",
            "NEEDS_ATTENTION": "reconcile",
        }.get(state["status"], "stopped")

    graph = StateGraph(OrderState)
    graph.add_node("submit", submit)
    graph.add_node("observe", observe)
    for name, action in {
        "complete": "Use the verified output.",
        "review": "Open the run in the dashboard for human approval.",
        "reconcile": "Inspect external evidence; do not create a replacement order.",
        "stopped": "Inspect the failed or cancelled run.",
    }.items():
        graph.add_node(name, lambda state, action=action: {"next_action": action})
        graph.add_edge(name, END)
    graph.add_edge(START, "submit")
    graph.add_edge("submit", "observe")
    graph.add_conditional_edges("observe", route, ["complete", "review", "reconcile", "stopped"])
    return graph.compile()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python examples/integrations/langgraph_order.py REQUEST_ID")
    client = AgentOperations(os.environ.get("AGENT_OPERATIONS_URL", "http://127.0.0.1:4300"),
                             os.environ["AGENT_OPERATIONS_API_KEY"])
    print(json.dumps(build_graph(client).invoke({"request_id": sys.argv[1], "item": "Notebook", "quantity": 2}), indent=2))
