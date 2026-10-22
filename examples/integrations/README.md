# Tested integration examples

Start the [local demo](../../docs/quickstart.md) in another terminal. From the repository root, use Python 3.11 or later:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install ./sdk/python -r examples/integrations/requirements.txt
export AGENT_OPERATIONS_URL=http://127.0.0.1:4300
export AGENT_OPERATIONS_API_KEY="$(python -c 'import json; print(json.load(open(".data/demo-workspace.json"))["token"])')"
```

This key belongs to your local disposable demo. For a real workspace, create a scoped key in Settings and supply it through your normal secret manager. Never post keys in issues.

## 1. Recover a lost HTTP response

```sh
python examples/integrations/recover_order.py tutorial-recovery-001
```

Expected: `SUCCEEDED`, `same_run_on_repeat: true`, one dispatch attempt and an output matching the requested order. Run it again with the same ID; it returns the same durable run. Use a new ID only for an intentionally new order.

## 2. Delegate an action from LangGraph

```sh
python examples/integrations/langgraph_order.py tutorial-graph-001
```

Expected: `WAITING_APPROVAL` and a `next_action` asking for review. Open the run in the dashboard, review and approve the exact action, then invoke the script again with the same ID. Expected: `SUCCEEDED` with the same run ID.

The graph executes real LangGraph nodes and conditional edges. It intentionally uses a deterministic input instead of a paid model. Replace the input-producing part with your own planner; keep the business request ID outside model control. This example uses the server's persisted run for recovery; it does not add durable persistence to the entire surrounding LangGraph graph.

## 3. Register an operation as a browser-use tool

```sh
python examples/integrations/browser_use_order.py tutorial-browser-001
```

The script invokes the actual browser-use tool registry. The tool submits `browser-order`, returns its run ID and dashboard URL, and ends the agent turn while approval is required. Approve it in the dashboard. The server fills the local supplier form with Chromium, captures a receipt, and verifies the API result. Calling the tool again with the same ID reads the same operation.

In your own browser-use application, pass `build_tools(client, application_request_id)` as the `tools` argument to `Agent`. An autonomous session needs your chosen model and may incur charges; the included test does not run one.

Only actions routed through this custom tool receive these approval and recovery checks. Other browser-use tools, direct browser clicks, and external API calls are outside that boundary. Do not give an agent an alternative write path if your application requires all writes to be reviewed.

## Verification

Pinned versions: LangGraph 1.2.16 and browser-use 0.13.11. The SDK is built from this repository. With the Python environment active and the product built:

```sh
pnpm exec playwright install chromium --only-shell
PYTHON="$(command -v python)" node scripts/test-integrations.mjs
```

The runner starts its own isolated local supplier and server, tests repeated submissions, uncertainty routing, tool registration, approval and real browser execution, then stops them. No model API key is required. CI runs the same tests on Linux.

Official API references: [LangGraph quickstart](https://docs.langchain.com/oss/python/langgraph/quickstart), [browser-use custom tools](https://docs.browser-use.com/open-source/customize/tools/add). These examples are Apache-2.0, like the rest of `examples/`. Dependencies retain their own licenses. There is no affiliation or endorsement claim.
