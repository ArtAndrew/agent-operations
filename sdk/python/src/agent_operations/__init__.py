# SPDX-License-Identifier: Apache-2.0
"""A dependency-free client for the Agent Operations API."""
from __future__ import annotations

import json
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class AgentOperationsError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status, self.code, self.details = status, code, details


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AgentOperations:
    def __init__(self, base_url: str, api_key: str, timeout: float = 30):
        parsed = urlsplit(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Use an HTTP(S) base URL without credentials, query or fragment")
        self.base_url = base_url.rstrip("/") + "/api/v1"
        self.api_key, self.timeout = api_key, timeout
        self._opener = build_opener(_NoRedirects())

    def _request(self, path: str, method: str = "GET", body: Any = None, headers: dict | None = None) -> Any:
        request = Request(
            self.base_url + path,
            data=None if body is None else json.dumps(body).encode("utf-8"),
            method=method,
            headers={"Authorization": "Bearer " + self.api_key, "Content-Type": "application/json", **(headers or {})},
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                payload = json.load(error).get("error", {})
            except (ValueError, AttributeError):
                payload = {}
            raise AgentOperationsError(error.code, payload.get("code", "REQUEST_FAILED"), payload.get("message", "Request failed"), payload.get("details")) from error

    def me(self) -> dict:
        return self._request("/me")

    def publish(self, operation: dict) -> dict:
        return self._request("/operations", "POST", operation)

    def operation(self, name: str, version: int | None = None) -> dict:
        return self._request("/operations/" + quote(name, safe="") + (f"?version={version}" if version else ""))

    def packages(self) -> dict:
        return self._request("/packages")

    def install_github_package(self, configuration: dict) -> dict:
        return self._request("/packages/github-issues/install", "POST", configuration)

    def submit(self, operation: str, inputs: dict, *, idempotency_key: str, version: int | None = None) -> dict:
        if not idempotency_key:
            raise ValueError("An idempotency key is required")
        body = {"operation": operation, "input": inputs}
        if version is not None:
            body["version"] = version
        return self._request("/runs", "POST", body, {"Idempotency-Key": idempotency_key})

    def run(self, run_id: str) -> dict:
        return self._request("/runs/" + quote(run_id, safe=""))

    def runs(self, *, status: str | None = None, limit: int = 50, before: str | None = None) -> dict:
        return self._request("/runs?" + urlencode({k: v for k, v in {"status": status, "limit": limit, "before": before}.items() if v is not None}))

    def cancel(self, run_id: str, reason: str) -> dict:
        return self._request("/runs/" + quote(run_id, safe="") + "/cancel", "POST", {"reason": reason})

    def reconcile(self, run_id: str, reason: str) -> dict:
        return self._request("/runs/" + quote(run_id, safe="") + "/reconcile", "POST", {"reason": reason})

    def resolve(self, run_id: str, *, outcome: str, reason: str, evidence: str, output: Any = None) -> dict:
        return self._request("/runs/" + quote(run_id, safe="") + "/resolve", "POST", {"outcome": outcome, "reason": reason, "evidence": evidence, "output": output})

    def approvals(self) -> dict:
        return self._request("/approvals")

    def decide(self, approval_id: str, decision: str, reason: str) -> dict:
        return self._request("/approvals/" + quote(approval_id, safe="") + "/decision", "POST", {"decision": decision, "reason": reason})

    def connect(self, *, name: str, kind: str, base_url: str, secret_headers: dict | None = None, idempotency_header: str | None = None) -> dict:
        body = {"name": name, "kind": kind, "baseUrl": base_url}
        if secret_headers is not None:
            body["secretHeaders"] = secret_headers
        if idempotency_header is not None:
            body["idempotencyHeader"] = idempotency_header
        return self._request("/connectors", "POST", body)

    def usage(self) -> dict:
        return self._request("/usage")

    def verify_audit(self) -> dict:
        return self._request("/audit/verify")

    def wait(self, run_id: str, *, timeout: float = 300, poll_interval: float = 1, stop_on_decision: bool = True) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.run(run_id)
            status = result["run"]["status"]
            if status in ("SUCCEEDED", "FAILED", "CANCELLED") or (stop_on_decision and status in ("WAITING_APPROVAL", "NEEDS_ATTENTION")):
                return result
            time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))
        raise AgentOperationsError(408, "WAIT_TIMEOUT", "Polling timed out; the operation is still tracked by the server")

    def tool(self, name: str, version: int | None = None) -> dict:
        operation = self.operation(name, version)["definition"]
        return {"type": "function", "function": {"name": "submit_" + name.replace("-", "_"), "description": operation.get("description") or "Submit " + name + " as a durable operation.", "parameters": operation.get("inputSchema", {"type": "object"})}}
