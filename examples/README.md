# Framework-neutral agent tools

For runnable LangGraph and browser-use integrations with pinned libraries, see the [tested integration examples](integrations/README.md).

The functions in this directory can be registered as tools in an external agent framework. They use the SDK to submit a pre-published operation and return its durable run ID and decision state.

The application supplies `purchaseRequestId`; it must remain stable across model retries. The agent should handle `WAITING_APPROVAL` by surfacing the run for review, and `NEEDS_ATTENTION` by surfacing uncertainty. It should not invent a new request ID to bypass either state.

These examples use the local `reviewed-order` definition. For a real provider, create the appropriate connection and publish a definition with a meaningful verification contract.

```sh
export AGENT_OPERATIONS_URL=http://127.0.0.1:4300
export AGENT_OPERATIONS_API_KEY=YOUR_WORKSPACE_KEY
python -m pip install ./sdk/python
python examples/agent-tool.py
```

The examples are Apache-2.0. They are framework-neutral and do not claim tested adapters for every agent framework.
