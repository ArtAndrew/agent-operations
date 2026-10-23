# Connect agents through MCP

Agent Operations provides a local stdio MCP server using the official MCP SDK. The API and workers run separately. The MCP process discovers installed package operations in one workspace and submits work through the authenticated API.

Build the project and configure your MCP client:

```json
{
  "mcpServers": {
    "agent-operations": {
      "command": "node",
      "args": ["/absolute/path/to/agent-operations/dist/cli.js", "mcp"],
      "env": {
        "AOP_BASE_URL": "http://127.0.0.1:4300",
        "AOP_API_KEY": "YOUR_WORKSPACE_OPERATOR_KEY"
      }
    }
  }
}
```

Use an operator key, not a platform or workspace administrator key. HTTPS is required except for loopback HTTP. The process sends protocol messages only to stdout. Credentials belong in the MCP client's secret/environment configuration, not in model prompts or committed files.

For an installation named `github-case`, the tools are:

- `run_github-case`: takes `requestKey` and `input` matching the installed operation's schema. It returns a tracked run immediately. Reuse the same request key for the same request.
- `operation_status`: takes `runId` and returns its state, steps, verification outputs and approval records.

Installed operation versions are pinned. Tools do not approve, manually resolve, change connections or install packages. An operator cannot bypass the approval policy through MCP. A queued run or `WAITING_EXTERNAL` result is not a completed operation. Let the human handle pending approvals in the dashboard, then check the same run.

Discovery is refreshed on each tools/list request. Clients which cache tools may need to refresh their list or reconnect after package installation. This version implements stdio, not a remote OAuth-enabled MCP endpoint.

For Deep Agents, see [the Python integration](../examples/integrations/deepagents_github.py). The application supplies a stable case ID; the model supplies the title and description. No additional agent runtime is embedded in the Agent Operations server.
