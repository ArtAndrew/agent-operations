# SPDX-License-Identifier: Apache-2.0
"""Tools for a Deep Agent that submits an installed GitHub issue operation.

The host application owns the case ID. Approval remains in Agent Operations.
Install requirements-deepagents.txt in addition to the Python SDK.
"""
from hashlib import sha256
from deepagents import create_deep_agent
from langchain_core.tools import tool


def build_tools(client, operation: str, case_id: str):
    @tool
    def submit_case(title: str, body: str) -> dict:
        """Request the configured GitHub issue operation. The returned run is not proof of completion."""
        return client.submit(
            operation,
            {"caseId": case_id, "title": title, "body": body},
            idempotency_key="case-" + sha256((operation + ":" + case_id).encode()).hexdigest(),
        )

    @tool
    def case_status(run_id: str) -> dict:
        """Read verified results. Waiting or approval states require follow-up; never describe them as finished."""
        result = client.run(run_id)
        return {"run": result["run"], "steps": result["steps"]}

    return [submit_case, case_status]


def build_agent(client, model, operation: str, case_id: str):
    return create_deep_agent(
        model=model,
        tools=build_tools(client, operation, case_id),
        system_prompt=(
            "Use submit_case for the requested GitHub case. Reuse the existing run. "
            "Use case_status to report its verified state. Do not claim completion "
            "while it is queued, waiting for approval, waiting externally or uncertain. "
            "Approvals are handled by a human in Agent Operations."
        ),
    )
