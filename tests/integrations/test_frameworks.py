import asyncio
import json
import os
from pathlib import Path
import sys
import unittest
from uuid import uuid4
from agent_operations import AgentOperations

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "examples" / "integrations"))
from langgraph_order import build_graph
from browser_use_order import build_tools
from recover_order import recover


class FrameworkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = AgentOperations(os.environ["AGENT_OPERATIONS_URL"], os.environ["AGENT_OPERATIONS_API_KEY"])

    def test_langgraph_reuses_request_and_routes_unknown_results(self):
        graph = build_graph(self.client, "create-order")
        inputs = {"request_id": "graph-" + uuid4().hex, "item": "Notebook", "quantity": 2, "mode": "lose-response"}
        first = graph.invoke(inputs)
        repeated = graph.invoke(inputs)
        self.assertEqual(first["status"], "SUCCEEDED")
        self.assertEqual(first["run_id"], repeated["run_id"])
        uncertain = graph.invoke({**inputs, "request_id": "unknown-" + uuid4().hex, "mode": "unverifiable"})
        self.assertEqual(uncertain["status"], "NEEDS_ATTENTION")
        self.assertIn("do not create", uncertain["next_action"])

    def test_browser_use_registry_waits_for_approval_then_browser_verifies(self):
        tools = build_tools(self.client, "browser-use-" + uuid4().hex)
        result = asyncio.run(tools.registry.execute_action("submit_supplier_order", {"item": "Notebook", "quantity": 2}))
        payload = json.loads(result.extracted_content)
        self.assertTrue(result.is_done)
        self.assertEqual(payload["status"], "WAITING_APPROVAL")
        approvals = self.client.approvals()["items"]
        approval = next(a for a in approvals if a["run_id"] == payload["run_id"])
        self.client.decide(approval["id"], "approve", "Local integration test: reviewed exact supplier action")
        completed = self.client.wait(payload["run_id"], timeout=60, stop_on_decision=False)
        self.assertEqual(completed["run"]["status"], "SUCCEEDED")
        self.assertEqual(completed["steps"][0]["attempts"], 1)

    def test_dependency_free_recovery_example(self):
        result = recover(self.client, "recovery-" + uuid4().hex)
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertTrue(result["same_run_on_repeat"])
        self.assertEqual(result["steps"][0]["attempts"], 1)


if __name__ == "__main__":
    unittest.main()
