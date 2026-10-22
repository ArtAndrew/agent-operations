# Operation definitions

Publish JSON to `POST /api/v1/operations`. Publishing the same name creates the next immutable version. Each run pins its version.

```json
{
  "name": "create-order",
  "description": "Create and independently verify a supplier order.",
  "inputSchema": {
    "type": "object",
    "required": ["id", "item", "quantity"],
    "properties": {
      "id": { "type": "string", "pattern": "^[a-zA-Z0-9_-]+$" },
      "item": { "type": "string" },
      "quantity": { "type": "integer", "minimum": 1 }
    }
  },
  "steps": [
    {
      "id": "create",
      "kind": "http",
      "connection": "supplier-api",
      "effect": "write",
      "businessKey": "{{ input.id }}",
      "approval": true,
      "request": {
        "method": "POST",
        "path": "/orders",
        "body": "{{ input }}"
      },
      "verify": {
        "kind": "http",
        "connection": "supplier-api",
        "request": { "path": "/orders/{{ input.id }}" },
        "assertions": [
          { "path": "id", "operator": "equals", "value": "{{ input.id }}" },
          { "path": "item", "operator": "equals", "value": "{{ input.item }}" },
          {
            "path": "quantity",
            "operator": "equals",
            "value": "{{ input.quantity }}"
          },
          { "path": "status", "operator": "equals", "value": "created" }
        ]
      }
    }
  ]
}
```

## Shared step properties

| Property            | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `id`                | Unique lowercase identifier within the operation.                 |
| `title`             | Optional display label.                                           |
| `effect`            | `read` (default) or `write`.                                      |
| `businessKey`       | Required for writes. Stable identifier for the external action.   |
| `approval`          | Wait for an exact-action approval before dispatch. Default false. |
| `timeoutMs`         | 100–120000 milliseconds. Default 30000.                           |
| `retry.maxAttempts` | 1–10 attempts, including the first. Default 3.                    |
| `retry.delayMs`     | Initial exponential-backoff delay. Default 1000.                  |
| `verify`            | Required for writes. Independent HTTP or browser read contract.   |

Operations contain 1–100 ordered steps. Names and step IDs match `^[a-z][a-z0-9_-]{0,63}$`.

## Templates

- `{{ input.id }}` reads the operation input.
- `{{ steps.analyze.summary }}` reads a previous step output.
- A template occupying the whole value preserves its JSON type.
- A template inside a longer string interpolates a scalar value.
- In a verifier, `{{ output.id }}` refers to the current execution output, if available.

Missing paths are errors. Templates never evaluate JavaScript. Prototype traversal is rejected. Template insertion does **not** URL-encode values or escape CSS selectors. Constrain interpolated identifiers in the input schema and do not put arbitrary text into a URL path or selector.

Prefer verification paths derived from durable input identifiers. A verifier that depends only on a response-generated ID may be impossible to use when that response is lost.

## Executors

**HTTP** uses a named HTTP connector, an HTTP method, a same-origin request path, optional headers and a JSON body. POST, PUT, PATCH and DELETE require `effect: "write"`. GET and HEAD cannot have a body. Responses are limited to 2 MB; redirects are rejected. Secret headers belong in the connector, not in operation definitions.

**Browser** uses a named browser connector and an isolated Chromium context. Supported actions: `goto`, `fill`, `click`, `select`, `press`, and `wait`. Extraction maps output keys to selectors; each value reads the element's text. Interactive recipes are classified as writes and require verification. A receipt screenshot is captured by default; use `screenshot: false` when it would record sensitive content. Requests must stay on the connector origin. Service workers, WebSockets and downloads are disabled. Browser contexts are not reused between steps.

**Agent** calls a model connector's `./chat/completions` endpoint with system instructions, a prompt and JSON-schema response format. Set `model`, `instructions`, `prompt`, `outputSchema` and optionally `maxTokens`. The provider must support this API shape. Model outputs are validated locally before becoming step outputs. This executor does not invoke model-selected tools; external actions are separate, explicit operation steps.

**Transform** returns its `value` after template resolution and optional assertions. It does not execute arbitrary code.

## Assertions

`path` is a dotted property path; `$` selects the whole value. Supported operators are `equals`, `exists`, `contains`, `greaterThan` and `lessThan`. Equality compares structured JSON values. `contains` supports a substring or an exact array element.

HTTP verification treats configured `absentStatuses` as absence; the default is `[404]`. Other HTTP failures and assertion mismatches are uncertain. Browser verification has no automatic absence result.

## Connections

Connections have a workspace-unique name, executor kind, base URL, optional public headers and encrypted secret headers. The platform must allow the exact URL origin. A model base URL generally needs a trailing path slash, such as `https://provider.example/v1/`.

Use credentials limited to the operation's intended account and permissions. Credentials can be rotated through the dashboard or API. In-flight external requests cannot be recalled by rotating a credential.
