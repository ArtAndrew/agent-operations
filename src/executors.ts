import { Github } from "./github.js";
import { chromium, type Browser } from "playwright";
import type { Store } from "./store.js";
import { Network } from "./network.js";
import {
  AppError,
  ExecutionError,
  emptyUsage,
  type Connector,
  type Step,
  type ResolvedStep,
  type ConnectionBinding,
  type Verification,
  type ExecutionResult,
  type Usage,
} from "./domain.js";
import { checkAssertions, validateInput } from "./util.js";
export interface VerificationResult {
  status: "confirmed" | "absent" | "unknown" | "pending";
  output?: unknown;
  reason?: string;
  usage: Usage;
}
export class Executors {
  public network: Network;
  constructor(private store: Store) {
    this.network = new Network(store.config);
  }
  private async browser(
    connector: Connector,
    signal: AbortSignal,
    readOnly = false,
  ) {
    signal.throwIfAborted();
    const { url, addresses } = await this.network.target(connector.base_url);
    const rules = "MAP " + url.hostname + " " + addresses[0]!.address;
    const browser = await chromium.launch({
      headless: true,
      args: ["--host-resolver-rules=" + rules],
      executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    });
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    const headers = this.store.connectorHeaders(connector);
    await context.route("**/*", async (route) => {
      try {
        const target = new URL(route.request().url());
        if (target.origin !== url.origin) throw new Error("Blocked origin");
        if (readOnly && !["GET", "HEAD"].includes(route.request().method()))
          throw new Error("Read-only browser request");
        if (!["http:", "https:"].includes(target.protocol))
          throw new Error("Blocked protocol");
        await route.continue({
          headers: { ...route.request().headers(), ...headers },
        });
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const abort = () => {
      void browser.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      await browser.close();
      signal.throwIfAborted();
    }
    return {
      browser,
      context,
      cleanup: () => {
        signal.removeEventListener("abort", abort);
        return browser.close();
      },
    };
  }
  async execute(
    workspaceId: string,
    step: ResolvedStep,
    actionKey: string | undefined,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (step.kind === "github_issue")
      return new Github(this.store, this.network).create(
        workspaceId,
        step,
        signal,
      );
    if (step.kind === "transform") {
      const errors = checkAssertions(step.value, step.assertions);
      if (errors.length) throw new ExecutionError(errors.join("; "));
      return { output: step.value, usage: emptyUsage() };
    }
    const connector = await this.store.connector(workspaceId, step.connection);
    this.store.checkBinding(connector, step.connections?.action);
    if (step.kind === "http") {
      if (connector.kind !== "http")
        throw new AppError(
          400,
          "CONNECTOR_KIND",
          "HTTP steps require an HTTP connector",
        );
      const headers: Record<string, string> = {
        ...this.store.connectorHeaders(connector),
        "content-type": "application/json",
        ...step.request.headers,
      };
      if (actionKey && connector.idempotency_header)
        headers[connector.idempotency_header] = actionKey;
      const result = await this.network.http(
        this.network.path(connector.base_url, step.request.path),
        {
          method: step.request.method,
          headers,
          body: step.request.body,
          signal,
          write: step.effect === "write",
        },
      );
      if (result.status >= 400)
        throw new ExecutionError(
          "Provider returned HTTP " + result.status,
          step.effect === "write",
          result.status === 429 || result.status >= 500,
          result.usage,
        );
      return { output: result.body, usage: result.usage };
    }
    if (step.kind === "agent") {
      if (connector.kind !== "model")
        throw new AppError(
          400,
          "CONNECTOR_KIND",
          "Agent steps require a model connector",
        );
      const result = await this.network.http(
        this.network.path(connector.base_url, "./chat/completions"),
        {
          method: "POST",
          headers: {
            ...this.store.connectorHeaders(connector),
            "content-type": "application/json",
          },
          signal,
          body: {
            model: step.model,
            messages: [
              {
                role: "system",
                content:
                  step.instructions +
                  " Return only valid JSON matching the requested schema.",
              },
              { role: "user", content: step.prompt },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "operation_result",
                strict: true,
                schema: step.outputSchema,
              },
            },
            max_tokens: step.maxTokens,
          },
        },
      );
      if (result.status >= 400)
        throw new ExecutionError(
          "Model provider returned HTTP " + result.status,
          false,
          result.status === 429 || result.status >= 500,
          result.usage,
        );
      const body = result.body as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const usage = {
        ...result.usage,
        inputTokens: body.usage?.prompt_tokens || 0,
        outputTokens: body.usage?.completion_tokens || 0,
      };
      let output: unknown;
      try {
        output = JSON.parse(body.choices?.[0]?.message?.content || "");
        validateInput(step.outputSchema, output);
      } catch {
        throw new ExecutionError(
          "Model response did not match the required JSON schema",
          false,
          true,
          usage,
        );
      }
      return { output, usage };
    }
    if (connector.kind !== "browser")
      throw new AppError(
        400,
        "CONNECTOR_KIND",
        "Browser steps require a browser connector",
      );
    const start = Date.now();
    let handle: Awaited<ReturnType<Executors["browser"]>> | undefined;
    try {
      handle = await this.browser(connector, signal, step.effect === "read");
      const page = await handle.context.newPage();
      page.setDefaultTimeout(step.timeoutMs);
      for (const action of step.actions) {
        signal.throwIfAborted();
        if (action.action === "goto")
          await page.goto(this.network.path(connector.base_url, action.path), {
            waitUntil: "domcontentloaded",
          });
        else if (action.action === "fill")
          await page.locator(action.selector).fill(String(action.value));
        else if (action.action === "click")
          await page.locator(action.selector).click();
        else if (action.action === "select")
          await page
            .locator(action.selector)
            .selectOption(String(action.value));
        else if (action.action === "press")
          await page.locator(action.selector).press(action.key);
        else
          await page.locator(action.selector).waitFor({ state: action.state });
      }
      const output: Record<string, unknown> = {};
      for (const [key, selector] of Object.entries(step.extract))
        output[key] = (await page.locator(selector).innerText()).slice(
          0,
          100000,
        );
      const artifacts = step.screenshot
        ? [
            {
              name: step.id + ".png",
              content: await page.screenshot({ fullPage: false }),
              contentType: "image/png",
            },
          ]
        : [];
      return {
        output,
        usage: { ...emptyUsage(), browserMs: Date.now() - start },
        artifacts,
      };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new ExecutionError(
        signal.aborted
          ? "Browser execution interrupted"
          : "Browser recipe failed",
        step.effect === "write",
        true,
        { ...emptyUsage(), browserMs: Date.now() - start },
      );
    } finally {
      await handle?.cleanup().catch(() => {});
    }
  }
  async verify(
    workspaceId: string,
    verification: Verification,
    signal: AbortSignal,
    binding?: ConnectionBinding,
  ): Promise<VerificationResult> {
    const connector = await this.store.connector(
      workspaceId,
      verification.connection,
    );
    this.store.checkBinding(connector, binding);
    if (verification.kind === "github_issue")
      return new Github(this.store, this.network).verify(
        workspaceId,
        verification,
        signal,
      );
    if (verification.kind === "http") {
      const r = await this.network.http(
        this.network.path(connector.base_url, verification.request.path),
        {
          method: verification.request.method,
          headers: {
            ...this.store.connectorHeaders(connector),
            ...verification.request.headers,
          },
          signal,
        },
      );
      if (verification.absentStatuses.includes(r.status))
        return {
          status: "absent",
          reason: "Provider reports the resource is absent",
          usage: r.usage,
        };
      if (r.status >= 400)
        return {
          status: "unknown",
          reason: "Verification returned HTTP " + r.status,
          usage: r.usage,
        };
      const errors = checkAssertions(r.body, verification.assertions);
      return errors.length
        ? {
            status: "unknown",
            reason: errors.join("; "),
            output: r.body,
            usage: r.usage,
          }
        : { status: "confirmed", output: r.body, usage: r.usage };
    }
    const start = Date.now();
    let handle: Awaited<ReturnType<Executors["browser"]>> | undefined;
    try {
      handle = await this.browser(connector, signal, true);
      const page = await handle.context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(
        this.network.path(connector.base_url, verification.path),
        { waitUntil: "domcontentloaded" },
      );
      const output: Record<string, unknown> = {};
      for (const [key, selector] of Object.entries(verification.extract))
        output[key] = (await page.locator(selector).innerText()).slice(
          0,
          100000,
        );
      const errors = checkAssertions(output, verification.assertions);
      const usage = { ...emptyUsage(), browserMs: Date.now() - start };
      return errors.length
        ? { status: "unknown", output, reason: errors.join("; "), usage }
        : { status: "confirmed", output, usage };
    } catch {
      return {
        status: "unknown",
        reason: "Browser verification could not establish the external result",
        usage: { ...emptyUsage(), browserMs: Date.now() - start },
      };
    } finally {
      await handle?.cleanup().catch(() => {});
    }
  }
}
