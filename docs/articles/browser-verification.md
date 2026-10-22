# A successful click is not a verified business result

A browser agent clicks **Create order** and the page closes. The browser may have sent the request, the server may have committed it, and the confirmation page may never have rendered. Reopening the form and clicking again can repeat a real action.

The useful question is whether the intended order exists. A screenshot can help an operator investigate, but it is not automatically authoritative evidence of a committed business event.

## Separate execution from verification

The `browser-order` demo uses an explicit browser recipe: navigate to the supplier form, fill the ID, item and quantity, submit, then wait for a receipt. It captures a screenshot as an artifact. A separate HTTP lookup checks the stored order's identity, item, quantity and status.

An API verifier is convenient when available. A browser verifier can instead read a stable receipt page and assert extracted fields. The operation author must choose an endpoint or page whose consistency and identity semantics are suitable for the business action.

## Try a browser action, then an uncertain result

Follow [scenario B in the quickstart](../quickstart.md#b-require-a-human-decision). Approve the exact browser action, inspect the resulting order, and download its screenshot from **Artifacts**.

Then follow [scenario C](../quickstart.md#c-make-the-outcome-uncertain). It intentionally makes the verifier unavailable. That scenario uses the supplier API for the write and demonstrates the shared uncertainty/reconciliation path: the run waits for evidence, and **Check again** reads the result without resending the mutation.

These are separate experiments. They do not establish that every browser crash or third-party website can be recovered automatically.

## Integrate without overstating coverage

The [browser-use example](../../examples/integrations/browser_use_order.py) registers a custom tool that delegates a protected action to this server. The server owns its browser recipe, approval and verification. browser-use keeps its own other tools and agent behavior.

Calls made through those other tools are outside this boundary. If an application requires all writes to be reviewed, it must prevent alternative write paths rather than relying on a prompt alone.

Read-only verifier restrictions also do not replace infrastructure egress isolation or a hostile-browser sandbox. Consult [security boundaries](../../SECURITY.md), [browser tests](../../tests/browser.test.ts), and [execution rules](../execution.md) before connecting an external site.
