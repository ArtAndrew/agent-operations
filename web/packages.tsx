import React, { useState } from "react";
import { send, useData } from "./api.js";
import {
  CopyButton,
  Empty,
  ErrorBox,
  Field,
  Modal,
  SectionTitle,
} from "./components.js";
import type { Connector, Me } from "./types.js";

interface Installed {
  id: string;
  package_version: string;
  operation_name: string;
  operation_version: number;
  config: {
    owner: string;
    repo: string;
    requireApproval: boolean;
    waitForCompleted: boolean;
  };
}
export function PackagesView({ me }: { me: Me }) {
  const packages = useData<{ items: Installed[] }>("/api/v1/packages");
  const connections = useData<{ items: Connector[] }>("/api/v1/connectors");
  const [install, setInstall] = useState(false),
    [connection, setConnection] = useState("");
  const [name, setName] = useState("github-case"),
    [owner, setOwner] = useState(""),
    [repo, setRepo] = useState("");
  const [approval, setApproval] = useState(true),
    [wait, setWait] = useState(false),
    [token, setToken] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [check, setCheck] = useState("");
  const [webhook, setWebhook] = useState<{ path: string; secret: string }>();
  const [run, setRun] = useState<Installed>(),
    [caseId, setCaseId] = useState(""),
    [title, setTitle] = useState(""),
    [body, setBody] = useState("");
  const configuration = () => ({
    name,
    connection,
    owner,
    repo,
    requireApproval: approval,
    waitForCompleted: wait,
  });
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const result = await send<{ id: string }>("/api/v1/connectors", {
        name: "github-" + crypto.randomUUID().slice(0, 8),
        kind: "http",
        baseUrl: "https://api.github.com",
        secretHeaders: { Authorization: "Bearer " + token },
      });
      setConnection(result.id);
      setToken("");
      connections.refresh();
      setCheck("Connection saved. Check repository access next.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setBusy(false);
    }
  }
  async function configure(save: boolean) {
    setBusy(true);
    setError("");
    setCheck("");
    try {
      if (save) {
        const result = await send<{
          webhook: { path: string; secret: string };
        }>("/api/v1/packages/github-issues/install", configuration());
        setWebhook(result.webhook);
        setInstall(false);
        packages.refresh();
      } else {
        const result = await send<{
          account: string;
          repository: string;
          note: string;
        }>("/api/v1/packages/github-issues/check", configuration());
        setCheck(
          `Connected as ${result.account} to ${result.repository}. ${result.note}`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Installation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SectionTitle
        title="Operation packages"
        description="Ready-to-configure actions with verification and recovery."
      />
      <ErrorBox>{packages.error}</ErrorBox>
      <section className="package-catalog">
        <article className="panel">
          <span className="eyebrow">GITHUB · VERSION 0.2.0</span>
          <h2>Track a case through GitHub</h2>
          <p>
            Create an issue from an agent request, verify it after a lost
            response, and optionally wait for completed closure.
          </p>
          <p>
            Works with GitHub.com personal access tokens. Existing issue content
            is checked against the approved request.
          </p>
          {me.role === "admin" ? (
            <button
              className="primary"
              onClick={() => {
                setInstall(true);
                setError("");
              }}
            >
              Install GitHub package
            </button>
          ) : (
            <p>Ask a workspace administrator to install a package.</p>
          )}
        </article>
      </section>
      <SectionTitle
        title="Installed packages"
        description="Each installation keeps its operation version and repository settings."
      />
      {!packages.data?.items.length ? (
        <Empty title="No packages installed">
          Install a package to make its operation available to your agents.
        </Empty>
      ) : (
        <div className="operation-grid">
          {packages.data.items.map((item) => (
            <article className="panel" key={item.id}>
              <h3>{item.operation_name}</h3>
              <p>
                {item.config.owner}/{item.config.repo}
              </p>
              <p>
                {item.config.requireApproval
                  ? "Human approval required"
                  : "Runs within configured permissions"}{" "}
                ·{" "}
                {item.config.waitForCompleted
                  ? "Waits for completed closure"
                  : "Confirms issue creation"}
              </p>
              <small>
                Package {item.package_version} · Operation v
                {item.operation_version}
              </small>
              <p>
                {["admin", "operator"].includes(me.role) ? (
                  <button
                    className="primary"
                    onClick={() => {
                      setRun(item);
                      setCaseId("");
                      setTitle("");
                      setBody("");
                      setError("");
                    }}
                  >
                    Run operation
                  </button>
                ) : null}
              </p>
              <details>
                <summary>Connect an agent</summary>
                <p>
                  MCP command: <code>node dist/cli.js mcp</code>
                </p>
                <p>
                  Set AOP_BASE_URL and AOP_API_KEY in the MCP client
                  environment. Use an operator key. The tool is{" "}
                  <code>run_{item.operation_name}</code>.
                </p>
              </details>
            </article>
          ))}
        </div>
      )}
      {install ? (
        <Modal
          title="Install GitHub package"
          onClose={() => {
            if (!busy) {
              setInstall(false);
              setToken("");
            }
          }}
        >
          <ErrorBox>{error || connections.error}</ErrorBox>
          <Field label="Connection">
            <select
              value={connection}
              onChange={(e) => {
                setConnection(e.target.value);
                setCheck("");
              }}
            >
              <option value="">Select a connection</option>
              {connections.data?.items
                .filter((c) => c.kind === "http")
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <details>
            <summary>Add a GitHub connection</summary>
            <p>
              Use a fine-grained personal access token limited to the target
              repository with Issues read/write and Metadata read access.
            </p>
            {!me.allowedOrigins.includes("https://api.github.com") ? (
              <ErrorBox>
                The server administrator must add https://api.github.com to
                ALLOWED_ORIGINS.
              </ErrorBox>
            ) : null}
            <Field label="GitHub token">
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            <button
              className="secondary"
              disabled={
                busy ||
                !token ||
                !me.allowedOrigins.includes("https://api.github.com")
              }
              onClick={() => void connect()}
            >
              Save connection
            </button>
          </details>
          <Field label="Operation name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Repository owner">
            <input
              value={owner}
              onChange={(e) => {
                setOwner(e.target.value);
                setCheck("");
              }}
            />
          </Field>
          <Field label="Repository name">
            <input
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                setCheck("");
              }}
            />
          </Field>
          <label className="check-row">
            <input
              type="checkbox"
              checked={approval}
              onChange={(e) => setApproval(e.target.checked)}
            />
            Require approval before creating an issue
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={wait}
              onChange={(e) => setWait(e.target.checked)}
            />
            Wait for the issue to be closed as completed (up to 7 days)
          </label>
          {check ? <p role="status">{check}</p> : null}
          <div className="button-group">
            <button
              className="secondary"
              disabled={busy || !connection || !owner || !repo}
              onClick={() => void configure(false)}
            >
              Check connection
            </button>
            <button
              className="primary"
              disabled={busy || !connection || !owner || !repo}
              onClick={() => void configure(true)}
            >
              {busy ? "Checking…" : "Install package"}
            </button>
          </div>
        </Modal>
      ) : null}
      {webhook ? (
        <Modal title="Package installed" onClose={() => setWebhook(undefined)}>
          <p>
            Polling is active. For faster updates, optionally configure a GitHub
            repository webhook with content type application/json and Issues
            events.
          </p>
          <Field label="Webhook URL">
            <input readOnly value={location.origin + webhook.path} />
          </Field>
          <Field label="Webhook secret — shown once">
            <input type="password" readOnly value={webhook.secret} />
          </Field>
          <CopyButton value={webhook.secret} />
          <p>
            GitHub needs a public HTTPS URL. Keep the secret in your webhook
            configuration.
          </p>
          <button className="primary" onClick={() => setWebhook(undefined)}>
            Done
          </button>
        </Modal>
      ) : null}
      {run ? (
        <Modal
          title={"Run " + run.operation_name}
          onClose={() => {
            if (!busy) setRun(undefined);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const result = await send<{ run: { id: string } }>(
                  "/api/v1/runs",
                  {
                    operation: run.operation_name,
                    version: run.operation_version,
                    input: { caseId, title, body },
                  },
                  "POST",
                  { "Idempotency-Key": `package:${run.id}:${caseId}` },
                );
                setRun(undefined);
                location.hash = "/runs/" + result.run.id;
              } catch (e) {
                setError(e instanceof Error ? e.message : "Run failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            <ErrorBox>{error}</ErrorBox>
            <Field label="Case ID">
              <input
                required
                maxLength={150}
                value={caseId}
                onChange={(e) => setCaseId(e.target.value)}
              />
            </Field>
            <p>
              Reuse the same case ID for the same request. This creates a real
              GitHub issue after any required approval.
            </p>
            <Field label="Issue title">
              <input
                required
                maxLength={256}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field label="Issue description">
              <textarea
                rows={6}
                maxLength={60000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
            <button className="primary" disabled={busy}>
              Submit operation
            </button>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
