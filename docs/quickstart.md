# First run: recover an order without sending it twice

This walkthrough uses a local supplier simulator. It needs no signup, cloud account, paid model key or external purchase. The suggested ten-minute session starts after dependencies and Chromium have downloaded; download time varies.

## Install and start

Use Node.js 22.12+ and pnpm 11.25.0. Run:

```sh
git clone https://github.com/ArtAndrew/agent-operations.git
cd agent-operations
git checkout v0.1.0
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium --only-shell
pnpm demo
```

On Linux, if Chromium reports missing system libraries, use `pnpm exec playwright install --with-deps chromium --only-shell`. This can require administrator access to install system packages. If your Node distribution omits Corepack, install pnpm using its [official installation instructions](https://pnpm.io/installation).

Open <http://127.0.0.1:4300> and choose **Enter demo workspace**. Leave the terminal running. The supplier portal is <http://127.0.0.1:4301>.

## A. Lose the response

Choose **New run**, select `create-order`, and enter:

```json
{
  "id": "first-recovery-001",
  "item": "Notebook",
  "quantity": 2,
  "mode": "lose-response"
}
```

Submit the run. Expected: **Succeeded**, **1 dispatch attempt**, and verified output matching the order. In the supplier portal, find `first-recovery-001`. The fixture stored it before intentionally dropping the POST response. The server confirmed it using a separate GET.

The demo supplier itself also rejects conflicting reuse of an order ID. The single-dispatch trace demonstrates this recovery path; it is not evidence that every third-party API supports exactly-once effects.

## B. Require a human decision

Create a `browser-order` run:

```json
{ "id": "first-browser-001", "item": "Notebook", "quantity": 2 }
```

Expected: **Waiting Approval**. Choose **Review approvals**, find this order and choose **Review action**. Inspect the connection, form fields and target. Record approval with a reason. Open the run again. Expected: **Succeeded**, verified output and a downloadable receipt under **Artifacts**.

## C. Make the outcome uncertain

Create a `create-order` run:

```json
{
  "id": "first-uncertain-001",
  "item": "Notebook",
  "quantity": 2,
  "mode": "unverifiable"
}
```

Expected: **Needs Attention**. In the supplier portal, open this order and choose **Restore verification endpoint**. Back in the run, choose **Check again**, enter a reason, and check the external result. Expected: **Succeeded** without another write dispatch.

## Repeat, stop, and troubleshoot

Use a new order ID for a deliberately new action. Keep the same ID when retrying the same business request. The [SDK examples](../examples/integrations/README.md) demonstrate reusing the request idempotency key as well.

Stop with Ctrl+C. `.data` retains your demo state for the next launch and is ignored by Git. If port 4300 or 4301 is occupied, stop the other instance or set `PORT` and `DEMO_PROVIDER_PORT` to unused ports. Open the corresponding dashboard port.

The demo model returns deterministic JSON. A successful demo does not establish model accuracy, provider-specific reliability or production capacity. Read [execution semantics](execution.md) and [security boundaries](../SECURITY.md) before connecting a real service.

## Send a useful report

[Open a first-run report](https://github.com/ArtAndrew/agent-operations/issues/new?template=first-run.yml) with your OS, installation path, which scenario you tried, and the first step that differed from the expected result. Include redacted errors and the real workflow you would like to automate. Do not include keys or customer records.
