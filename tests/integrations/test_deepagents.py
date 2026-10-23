import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "examples" / "integrations"))
from deepagents_github import build_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage


class ToolModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


class DeepAgentTests(unittest.TestCase):
    def test_real_deep_agent_dispatches_the_operation_tool(self):
        calls = []

        class RecordingClient:
            def submit(self, operation, inputs, **kwargs):
                calls.append((operation, inputs, kwargs))
                return {"run": {"id": "test-run", "status": "WAITING_APPROVAL"}}

        model = ToolModel(responses=[
            AIMessage(content="", tool_calls=[{"name": "submit_case", "args": {"title": "Investigate", "body": "Case details"}, "id": "one", "type": "tool_call"}]),
            AIMessage(content="The operation is waiting for human approval."),
        ])
        agent = build_agent(RecordingClient(), model, "github-case", "case-42")
        result = agent.invoke({"messages": [{"role": "user", "content": "Create the requested case"}]})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["caseId"], "case-42")
        self.assertIn("approval", result["messages"][-1].content)
