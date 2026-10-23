# Agent Operations Python SDK

A dependency-free Python 3.10+ client under Apache-2.0.

```sh
python -m pip install https://github.com/ArtAndrew/agent-operations/releases/download/v0.2.0/agent_operations_sdk-0.2.0-py3-none-any.whl
```

From a source checkout, use `python -m pip install ./sdk/python` instead. The wheel is distributed through GitHub Release and does not require publication to PyPI.

```python
import os
from agent_operations import AgentOperations

client = AgentOperations(
    os.environ["AGENT_OPERATIONS_URL"],
    os.environ["AGENT_OPERATIONS_API_KEY"],
)
submitted = client.submit(
    "create-order",
    {"id": "order-42", "item": "Notebook", "quantity": 2},
    idempotency_key="purchase-request-42",
)
result = client.wait(submitted["run"]["id"], timeout=60)
print(result["run"]["status"], result["run"]["outputs"])
```

Reuse the request key after a network error. The client does not silently retry mutations. HTTP failures raise `AgentOperationsError` with `status`, `code` and optional `details`.

`wait` returns when the operation finishes or needs approval/attention. A local polling timeout does not cancel a run. Set `stop_on_decision=False` to keep polling through human review.

This client is synchronous. Async applications can run calls in their existing thread pool or use the REST API with an async HTTP client.

`tool(name)` returns a JSON Schema function-tool description for an external agent integration. Map calls to `submit` with an application-owned idempotency key; do not create a new business identity on each model retry.
