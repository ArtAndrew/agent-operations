import React, { useState, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Blocks,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileCode2,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Unplug,
  Workflow,
  XCircle,
} from "lucide-react";
import { api, send, useData, ApiError } from "./api.js";
import {
  ActionForm,
  Badge,
  CopyButton,
  date,
  Empty,
  ErrorBox,
  Field,
  Json,
  Loading,
  Modal,
  number,
  pretty,
  SectionTitle,
  short,
} from "./components.js";
import type {
  Approval,
  Connector,
  Detail,
  Event,
  Key,
  Me,
  Operation,
  PublishedOperation,
  Run,
  Usage,
  Workspace,
} from "./types.js";
import "./style.css";
const go = (path: string) => {
  window.location.hash = path;
};
const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"];
function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const update = () => setRoute(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
function App() {
  const [me, setMe] = useState<Me>(),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [runModal, setRunModal] = useState(false);
  const route = useRoute();
  async function load() {
    try {
      setMe(await api<Me>("/api/v1/me"));
      setError("");
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401))
        setError(e instanceof Error ? e.message : "Connection failed");
      setMe(undefined);
    } finally {
      setReady(true);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function logout() {
    try {
      await api("/api/session", { method: "DELETE" });
      setMe(undefined);
      go("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign out failed");
    }
  }
  if (!ready)
    return (
      <div className="splash">
        <Brand />
        <Loading />
      </div>
    );
  if (!me) return <Login onLogin={load} initialError={error} />;
  if (me.platform) return <Platform onLogin={load} onLogout={logout} />;
  const canRun = ["admin", "operator"].includes(me.role);
  const nav = [
    { path: "/", label: "Overview", icon: LayoutDashboard },
    { path: "/runs", label: "Runs", icon: Workflow },
    { path: "/operations", label: "Operations", icon: FileCode2 },
    { path: "/approvals", label: "Approvals", icon: ShieldCheck },
    { path: "/connections", label: "Connections", icon: Unplug },
    { path: "/usage", label: "Usage", icon: Activity },
    { path: "/settings", label: "Settings", icon: Settings },
  ];
  let content: ReactNode;
  if (route.startsWith("/runs/"))
    content = <RunDetail id={route.split("/")[2]!} me={me} />;
  else if (route === "/runs")
    content = <Runs onRun={() => setRunModal(true)} canRun={canRun} />;
  else if (route === "/operations") content = <Operations me={me} />;
  else if (route === "/approvals") content = <Approvals me={me} />;
  else if (route === "/connections") content = <Connections me={me} />;
  else if (route === "/usage")
    content = <UsageView canReview={["admin", "reviewer"].includes(me.role)} />;
  else if (route === "/settings")
    content = <SettingsView me={me} reload={load} />;
  else content = <Overview onRun={() => setRunModal(true)} canRun={canRun} />;
  return (
    <div className="shell">
      <aside>
        <Brand />
        <div className="workspace-chip">
          <div className="workspace-avatar">
            {me.workspace.name.slice(0, 1)}
          </div>
          <div>
            <strong>{me.workspace.name}</strong>
            <span>{me.role} access</span>
          </div>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {nav.map(({ path, label, icon: Icon }) => (
            <a
              href={"#" + path}
              className={
                (path === "/" ? route === "/" : route.startsWith(path))
                  ? "active"
                  : ""
              }
              key={path}
            >
              <Icon size={18} />
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="runtime-state">
            <span className="live-dot" /> Durable execution
          </div>
          <small>Agent Operations · v0.1.0</small>
          <button className="text-button" onClick={() => void logout()}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{me.workspace.name}</strong>
          </div>
          <div className="topbar-right">
            <span className="access-chip">{me.role}</span>
            {canRun ? (
              <button
                className="primary small"
                onClick={() => setRunModal(true)}
              >
                <Plus size={15} /> New run
              </button>
            ) : null}
          </div>
        </header>
        <main>
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          {content}
        </main>
        <footer>
          Actions have receipts. Uncertainty stays visible.
          <span>Source available · Elastic License 2.0</span>
        </footer>
      </div>
      {runModal ? <RunModal onClose={() => setRunModal(false)} /> : null}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <GitBranch size={22} />
      </div>
      <div>
        Agent<span>Operations</span>
      </div>
    </div>
  );
}
function Login({
  onLogin,
  initialError,
}: {
  onLogin: () => Promise<void>;
  initialError: string;
}) {
  const [token, setToken] = useState(""),
    [error, setError] = useState(initialError),
    settings = useData<{ demo: boolean }>("/api/config", 0);
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">FROM INTENT TO VERIFIED RESULT</span>
          <h1>
            Keep your agents
            <br />
            on the record.
          </h1>
          <p>
            Run API and browser operations with persistent state, exact-action
            approvals and independent verification.
          </p>
          <div className="login-steps">
            <span>
              <Workflow /> Execute
            </span>
            <ArrowRight />
            <span>
              <ShieldCheck /> Verify
            </span>
            <ArrowRight />
            <span>
              <CheckCircle2 /> Record
            </span>
          </div>
        </div>
        <small>Built for operations that change real systems.</small>
      </div>
      <section className="login-card">
        <span className="eyebrow">AGENT OPERATIONS</span>
        <h2>Open your workspace</h2>
        <p>
          Sign in with a workspace API key or the platform administrator token.
        </p>
        <ActionForm
          label="Sign in"
          onSubmit={async () => {
            await send("/api/session", { token });
            await onLogin();
          }}
        >
          <Field label="Access token">
            <input
              autoFocus
              type="password"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="aok_…"
              autoComplete="current-password"
            />
          </Field>
        </ActionForm>
        {settings.data?.demo ? (
          <>
            <div className="divider">
              <span>LOCAL DEMO</span>
            </div>
            <button
              className="secondary full"
              onClick={() => {
                void send("/api/demo/session", {})
                  .then(onLogin)
                  .catch((e) => setError(e.message));
              }}
            >
              <Play size={16} /> Enter demo workspace
            </button>
            <small>
              The demo uses a local supplier portal. No external purchases or
              paid model calls.
            </small>
          </>
        ) : (
          <small>Your administrator can create an API key for your role.</small>
        )}
        <ErrorBox>{error || settings.error}</ErrorBox>
      </section>
    </div>
  );
}
function Platform({
  onLogin,
  onLogout,
}: {
  onLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const workspaces = useData<{ items: Workspace[] }>("/api/v1/workspaces"),
    [name, setName] = useState(""),
    [created, setCreated] = useState<{ token: string; name: string }>();
  return (
    <div className="platform">
      <header>
        <Brand />
        <button className="secondary" onClick={() => void onLogout()}>
          Sign out
        </button>
      </header>
      <SectionTitle
        title="Platform administration"
        description="Create isolated workspaces and hand their initial keys to administrators."
      />
      <div className="two-columns">
        <section className="panel">
          <h2>Create a workspace</h2>
          <ActionForm
            label="Create workspace"
            onSubmit={async () => {
              setCreated(await send("/api/v1/workspaces", { name }));
              setName("");
              workspaces.refresh();
            }}
          >
            <Field label="Workspace name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Operations"
              />
            </Field>
          </ActionForm>
          {created ? (
            <div className="token-reveal">
              <strong>Save this key for {created.name}</strong>
              <p>It is only shown after creation.</p>
              <code>{created.token}</code>
              <CopyButton value={created.token} />
              <button
                className="primary"
                onClick={() =>
                  void send("/api/session", { token: created.token }).then(
                    onLogin,
                  )
                }
              >
                Open workspace
              </button>
            </div>
          ) : null}
        </section>
        <section className="panel">
          <h2>Workspaces</h2>
          <ErrorBox>{workspaces.error}</ErrorBox>
          {workspaces.data?.items.map((w) => (
            <div className="list-row" key={w.id}>
              <div>
                <strong>{w.name}</strong>
                <small>{w.id}</small>
              </div>
              <span>{number(w.max_runs_per_day)} runs/day</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
function RunTable({ runs }: { runs: Run[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Operation / Run</th>
            <th>Status</th>
            <th>Version</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <a className="run-link" href={"#/runs/" + run.id}>
                  {run.operation_name}
                </a>
                <small>{short(run.id)}</small>
              </td>
              <td>
                <Badge status={run.status} />
              </td>
              <td>
                <span className="version">v{run.version}</span>
              </td>
              <td className="muted">{date(run.created_at)}</td>
              <td>
                <a
                  className="icon-button"
                  aria-label={"Open run " + short(run.id)}
                  href={"#/runs/" + run.id}
                >
                  <ArrowUpRight size={17} />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Overview({ onRun, canRun }: { onRun: () => void; canRun: boolean }) {
  const runs = useData<{ items: Run[] }>("/api/v1/runs?limit=8"),
    usage = useData<Usage>("/api/v1/usage"),
    events = useData<{ items: Event[] }>("/api/v1/events");
  const count = (status: string) =>
      usage.data?.runs.find((r) => r.status === status)?.count || 0,
    total = usage.data?.runs.reduce((n, r) => n + r.count, 0) || 0;
  return (
    <>
      <SectionTitle
        title="Operations overview"
        description="A clear record of what ran, what changed and what needs a decision."
      >
        <button
          className="secondary"
          onClick={() => {
            runs.refresh();
            usage.refresh();
            events.refresh();
          }}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </SectionTitle>
      <ErrorBox>{runs.error || usage.error || events.error}</ErrorBox>
      <div className="metrics">
        <Metric
          label="Total runs"
          value={total}
          icon={<Workflow />}
          hint="Across this workspace"
        />
        <Metric
          label="Completed"
          value={count("SUCCEEDED")}
          icon={<CheckCircle2 />}
          hint="All steps finished"
          tone="green"
        />
        <Metric
          label="Awaiting approval"
          value={count("WAITING_APPROVAL")}
          icon={<ShieldCheck />}
          hint="Review the exact action"
          tone="amber"
        />
        <Metric
          label="Needs attention"
          value={count("NEEDS_ATTENTION")}
          icon={<Activity />}
          hint="External result is uncertain"
          tone="red"
        />
      </div>
      <div className="overview-grid">
        <section className="panel no-padding">
          <div className="panel-heading">
            <div>
              <h2>Recent runs</h2>
              <p>Execution and verification in one place.</p>
            </div>
            <a href="#/runs" className="text-button">
              View all <ArrowRight size={15} />
            </a>
          </div>
          {runs.loading ? (
            <Loading />
          ) : runs.data?.items.length ? (
            <RunTable runs={runs.data.items} />
          ) : (
            <Empty title="Your first operation starts here">
              Publish an operation, connect a provider and submit a run.
              {canRun ? (
                <button className="primary" onClick={onRun}>
                  New run
                </button>
              ) : null}
            </Empty>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading compact">
            <h2>Activity</h2>
            <span className="live-dot" />
          </div>
          <div className="activity-list">
            {events.data?.items.slice(0, 7).map((e) => (
              <div className="activity-item" key={e.id}>
                <div className="activity-dot" />
                <div>
                  <strong>
                    {e.type.replaceAll(".", " · ").replaceAll("_", " ")}
                  </strong>
                  <small>{date(e.created_at)}</small>
                  {e.run_id ? (
                    <a href={"#/runs/" + e.run_id}>Run {short(e.run_id)}</a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {events.data && !events.data.items.length ? (
            <Empty title="No activity yet" />
          ) : null}
        </section>
      </div>
      <div className="principles">
        <div>
          <ShieldCheck />
          <strong>Review before action</strong>
          <p>Approvals bind to an immutable action payload.</p>
        </div>
        <div>
          <GitBranch />
          <strong>Resume with context</strong>
          <p>Persisted state survives worker restarts.</p>
        </div>
        <div>
          <Search />
          <strong>Verify the outcome</strong>
          <p>Uncertain writes wait for evidence before replay.</p>
        </div>
      </div>
    </>
  );
}
function Metric({
  label,
  value,
  icon,
  hint,
  tone = "blue",
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  hint: string;
  tone?: string;
}) {
  return (
    <div className="metric">
      <div className="metric-top">
        <span>{label}</span>
        <div className={"metric-icon " + tone}>{icon}</div>
      </div>
      <strong>{number(value)}</strong>
      <small>{hint}</small>
    </div>
  );
}
function Runs({ onRun, canRun }: { onRun: () => void; canRun: boolean }) {
  const [status, setStatus] = useState(""),
    [query, setQuery] = useState("");
  const runs = useData<{ items: Run[] }>(
    "/api/v1/runs?limit=200" + (status ? "&status=" + status : ""),
  );
  const filtered =
    runs.data?.items.filter((r) =>
      (r.operation_name + " " + r.id).includes(query),
    ) || [];
  return (
    <>
      <SectionTitle
        title="Runs"
        description="Inspect each attempt, approval and external result."
      >
        {canRun ? (
          <button className="primary" onClick={onRun}>
            <Plus size={16} /> New run
          </button>
        ) : null}
      </SectionTitle>
      <div className="toolbar">
        <div className="search-input">
          <Search size={17} />
          <input
            placeholder="Find an operation or run ID"
            aria-label="Search runs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {[
            "QUEUED",
            "RUNNING",
            "RETRYING",
            "WAITING_APPROVAL",
            "NEEDS_ATTENTION",
            "SUCCEEDED",
            "FAILED",
            "CANCELLED",
          ].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label="Refresh runs"
          onClick={runs.refresh}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <ErrorBox>{runs.error}</ErrorBox>
      <section className="panel no-padding">
        {runs.loading ? (
          <Loading />
        ) : filtered.length ? (
          <RunTable runs={filtered} />
        ) : (
          <Empty title="No matching runs">
            Try another filter or submit an operation.
          </Empty>
        )}
      </section>
      <p className="footnote">
        Showing up to the 200 most recent matching runs. The API supports
        pagination for older history.
      </p>
    </>
  );
}
function RunModal({
  onClose,
  operation,
}: {
  onClose: () => void;
  operation?: string;
}) {
  const operations = useData<{ items: PublishedOperation[] }>(
      "/api/v1/operations",
      0,
    ),
    [selected, setSelected] = useState(operation || ""),
    [input, setInput] = useState(
      pretty({
        id: "order-" + Date.now().toString(36),
        item: "Notebook",
        quantity: 2,
        mode: "normal",
      }),
    ),
    [key, setKey] = useState<string>(crypto.randomUUID()),
    [version, setVersion] = useState("");
  useEffect(() => {
    if (!selected && operations.data?.items[0])
      setSelected(operations.data.items[0].name);
  }, [operations.data, selected]);
  const definition = operations.data?.items.find((o) => o.name === selected);
  return (
    <Modal title="Start an operation" onClose={onClose} wide>
      <ErrorBox>{operations.error}</ErrorBox>
      {operations.loading ? (
        <Loading />
      ) : !operations.data?.items.length ? (
        <Empty title="Publish an operation first">
          <a href="#/operations" onClick={onClose}>
            Go to operations
          </a>
        </Empty>
      ) : (
        <ActionForm
          label="Submit run"
          onSubmit={async () => {
            const result = await send<{ run: Run }>(
              "/api/v1/runs",
              {
                operation: selected,
                input: JSON.parse(input),
                version: version ? Number(version) : undefined,
              },
              "POST",
              { "Idempotency-Key": key },
            );
            onClose();
            go("/runs/" + result.run.id);
          }}
        >
          <div className="two-columns">
            <Field label="Operation">
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                {operations.data.items.map((o) => (
                  <option key={o.id} value={o.name}>
                    {o.name} · v{o.version}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Version"
              help="Leave blank to use the current published version."
            >
              <input
                type="number"
                min="1"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="Latest"
              />
            </Field>
          </div>
          <p className="muted">{definition?.definition.description}</p>
          <Field label="Input JSON">
            <textarea
              className="code-editor"
              rows={9}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              required
            />
          </Field>
          <details>
            <summary>Input schema</summary>
            <Json value={definition?.definition.inputSchema} />
          </details>
          <Field
            label="Idempotency key"
            help="Reuse this key when retrying the same submission."
          >
            <input
              required
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
        </ActionForm>
      )}
    </Modal>
  );
}
function RunDetail({ id, me }: { id: string; me: Me }) {
  const detail = useData<Detail>("/api/v1/runs/" + id),
    [action, setAction] = useState<"cancel" | "reconcile" | "resolve">(),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [outcome, setOutcome] = useState("confirmed"),
    [output, setOutput] = useState("{}"),
    [tab, setTab] = useState("steps");
  const run = detail.data?.run,
    canOperate = ["admin", "operator"].includes(me.role),
    canReview = ["admin", "reviewer"].includes(me.role);
  if (detail.loading) return <Loading />;
  if (!detail.data || !run)
    return <ErrorBox>{detail.error || "Run not found"}</ErrorBox>;
  return (
    <>
      <a className="back-link" href="#/runs">
        ← All runs
      </a>
      <SectionTitle title={run.operation_name} description={"Run " + run.id}>
        <Badge status={run.status} />
        <button
          className="icon-button"
          onClick={detail.refresh}
          aria-label="Refresh run"
        >
          <RefreshCw size={17} />
        </button>
      </SectionTitle>
      <ErrorBox>{detail.error}</ErrorBox>
      <div className="run-meta">
        <span>
          <strong>Version</strong> v{run.version}
        </span>
        <span>
          <strong>Created</strong> {date(run.created_at)}
        </span>
        <span>
          <strong>Updated</strong> {date(run.updated_at)}
        </span>
        <span>
          <strong>Request key</strong> <code>{run.idempotency_key}</code>
          <CopyButton value={run.idempotency_key} />
        </span>
      </div>
      {run.status === "NEEDS_ATTENTION" ? (
        <div className="attention-banner">
          <Activity />
          <div>
            <strong>The external result is uncertain.</strong>
            <p>
              {run.error} Reconciliation checks the provider without sending the
              write again.
            </p>
          </div>
          <div className="button-group">
            {canOperate || canReview ? (
              <button
                className="secondary"
                onClick={() => setAction("reconcile")}
              >
                Check again
              </button>
            ) : null}
            {canReview ? (
              <button className="primary" onClick={() => setAction("resolve")}>
                Resolve with evidence
              </button>
            ) : null}
          </div>
        </div>
      ) : run.error ? (
        <ErrorBox>{run.error}</ErrorBox>
      ) : null}
      {run.status === "WAITING_APPROVAL" ? (
        <div className="info-banner">
          <ShieldCheck />
          <div>
            <strong>Waiting for an action review</strong>
            <p>Execution resumes after the exact payload is approved.</p>
          </div>
          <a href="#/approvals" className="primary">
            Review approvals
          </a>
        </div>
      ) : null}
      {canOperate &&
      !terminal.includes(run.status) &&
      run.status !== "NEEDS_ATTENTION" ? (
        <div className="run-actions">
          <button
            className="secondary danger-text"
            disabled={run.cancel_requested}
            onClick={() => setAction("cancel")}
          >
            {run.cancel_requested
              ? "Cancellation requested"
              : "Request cancellation"}
          </button>
        </div>
      ) : null}
      <div className="tabs">
        {[
          "steps",
          "input & output",
          "attempts",
          "audit trail",
          "artifacts",
        ].map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "steps" ? (
        <section className="step-list">
          {detail.data.steps.map((step, index) => (
            <article className="step-card" key={step.id}>
              <div className="step-number">
                {step.status === "SUCCEEDED" ? (
                  <CheckCircle2 size={20} />
                ) : (
                  index + 1
                )}
              </div>
              <div className="step-content">
                <div className="step-heading">
                  <div>
                    <h3>{step.resolved?.title || step.step_id}</h3>
                    <small>
                      {step.resolved?.kind || "Awaiting execution"} ·{" "}
                      {step.attempts} dispatch{" "}
                      {step.attempts === 1 ? "attempt" : "attempts"}
                    </small>
                  </div>
                  <Badge status={step.status} />
                </div>
                {step.error ? <ErrorBox>{step.error}</ErrorBox> : null}
                {step.digest ? (
                  <p className="digest">
                    Action digest <code>{step.digest}</code>
                    <CopyButton value={step.digest} />
                  </p>
                ) : null}
                <details>
                  <summary>Resolved action</summary>
                  <Json value={step.resolved} />
                </details>
                {step.output !== null ? (
                  <details open>
                    <summary>
                      {step.resolved?.verify
                        ? "Verified output"
                        : "Step output"}
                    </summary>
                    <Json value={step.output} />
                  </details>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      ) : null}
      {tab === "input & output" ? (
        <div className="two-columns">
          <section className="panel">
            <h2>Input</h2>
            <Json value={run.input} />
          </section>
          <section className="panel">
            <h2>Step outputs</h2>
            <Json value={run.outputs} />
          </section>
        </div>
      ) : null}
      {tab === "attempts" ? (
        <section className="panel no-padding">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Phase</th>
                  <th>Result</th>
                  <th>Duration</th>
                  <th>Usage</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.attempts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.step_id}</td>
                    <td>{a.phase}</td>
                    <td>
                      <Badge status={a.status} />
                      {a.error ? <small>{a.error}</small> : null}
                    </td>
                    <td>{number(a.duration_ms)} ms</td>
                    <td>
                      {a.usage.httpRequests} HTTP ·{" "}
                      {number(a.usage.inputTokens + a.usage.outputTokens)}{" "}
                      tokens
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!detail.data.attempts.length ? (
            <Empty title="No attempts yet" />
          ) : null}
        </section>
      ) : null}
      {tab === "audit trail" ? (
        <section className="panel">
          <h2>Run event history</h2>
          {detail.data.events.map((e) => (
            <details className="event-detail" key={e.id}>
              <summary>
                <strong>{e.type}</strong>
                <span>{date(e.created_at)}</span>
              </summary>
              <Json value={{ actor: e.actor, data: e.data, hash: e.hash }} />
            </details>
          ))}
        </section>
      ) : null}
      {tab === "artifacts" ? (
        <section className="panel">
          <h2>Receipts and artifacts</h2>
          {detail.data.artifacts.map((a) => (
            <div className="list-row" key={a.id}>
              <div>
                <strong>{a.name}</strong>
                <small>
                  {a.step_id} · {number(a.size_bytes)} bytes
                </small>
                <code className="digest">{a.sha256}</code>
              </div>
              <a
                className="secondary"
                href={"/api/v1/artifacts/" + a.id}
                download
              >
                Download
              </a>
            </div>
          ))}
          {!detail.data.artifacts.length ? (
            <Empty title="No artifacts">
              Browser steps can capture a screenshot of their result.
            </Empty>
          ) : null}
        </section>
      ) : null}
      {action ? (
        <Modal
          title={
            action === "resolve"
              ? "Resolve an uncertain action"
              : action === "cancel"
                ? "Request cancellation"
                : "Reconcile external state"
          }
          onClose={() => setAction(undefined)}
        >
          <ActionForm
            label={
              action === "resolve"
                ? "Record resolution"
                : action === "cancel"
                  ? "Request cancellation"
                  : "Check external result"
            }
            onSubmit={async () => {
              await send("/api/v1/runs/" + id + "/" + action, {
                reason,
                ...(action === "resolve"
                  ? { outcome, evidence, output: JSON.parse(output) }
                  : {}),
              });
              setAction(undefined);
              setReason("");
              detail.refresh();
            }}
          >
            {action === "cancel" ? (
              <p>
                An in-flight write must finish verification before cancellation
                can take effect.
              </p>
            ) : null}
            {action === "resolve" ? (
              <>
                <p>
                  This records an operator decision. Use an external receipt or
                  a provider investigation as evidence.
                </p>
                <Field label="Outcome">
                  <select
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                  >
                    <option value="confirmed">
                      Confirmed: the intended action completed
                    </option>
                    <option value="failed">
                      Closed as failed: do not replay this action
                    </option>
                  </select>
                </Field>
                <Field label="Evidence">
                  <textarea
                    required
                    minLength={3}
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    placeholder="Provider receipt, ticket or investigation reference"
                  />
                </Field>
                <Field
                  label="Output JSON"
                  help="This output becomes available to subsequent steps."
                >
                  <textarea
                    className="code-editor"
                    rows={5}
                    value={output}
                    onChange={(e) => setOutput(e.target.value)}
                    required
                  />
                </Field>
              </>
            ) : null}
            <Field label="Reason">
              <textarea
                minLength={3}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </ActionForm>
        </Modal>
      ) : null}
    </>
  );
}
const starter = {
  name: "echo",
  description: "Validate input and return a structured result.",
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: { message: { type: "string" } },
  },
  steps: [
    {
      id: "result",
      kind: "transform",
      value: { message: "{{ input.message }}" },
    },
  ],
};
function Operations({ me }: { me: Me }) {
  const list = useData<{ items: PublishedOperation[] }>("/api/v1/operations"),
    [editor, setEditor] = useState<string>(),
    [run, setRun] = useState<string>(),
    [view, setView] = useState<PublishedOperation>();
  return (
    <>
      <SectionTitle
        title="Operations"
        description="Versioned definitions for repeatable, verifiable work."
      >
        {me.role === "admin" ? (
          <button
            className="primary"
            onClick={() => setEditor(pretty(starter))}
          >
            <Plus size={16} /> Publish operation
          </button>
        ) : null}
      </SectionTitle>
      <ErrorBox>{list.error}</ErrorBox>
      {list.loading ? (
        <Loading />
      ) : (
        <div className="operation-grid">
          {list.data?.items.map((op) => (
            <article className="panel operation-card" key={op.id}>
              <div className="operation-top">
                <div className="operation-icon">
                  <FileCode2 size={23} />
                </div>
                <span className="version">v{op.version}</span>
              </div>
              <h2>{op.name}</h2>
              <p>{op.definition.description || "No description provided."}</p>
              <div className="operation-kinds">
                {[...new Set(op.definition.steps.map((s) => s.kind))].map(
                  (k) => (
                    <span key={k}>{k}</span>
                  ),
                )}
                <span>{op.definition.steps.length} steps</span>
              </div>
              <div className="card-actions">
                <button className="secondary" onClick={() => setView(op)}>
                  Definition
                </button>
                {["admin", "operator"].includes(me.role) ? (
                  <button className="primary" onClick={() => setRun(op.name)}>
                    <Play size={14} /> Run
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
      {list.data && !list.data.items.length ? (
        <Empty title="No published operations">
          Create a definition to establish its input contract and execution
          steps.
        </Empty>
      ) : null}
      {editor !== undefined ? (
        <Modal
          title="Publish an operation version"
          onClose={() => setEditor(undefined)}
          wide
        >
          <ActionForm
            label="Publish version"
            onSubmit={async () => {
              await send("/api/v1/operations", JSON.parse(editor));
              setEditor(undefined);
              list.refresh();
            }}
          >
            <p>
              Publishing an existing name creates a new immutable version.
              Existing runs keep their original version.
            </p>
            <Field label="Operation definition">
              <textarea
                className="code-editor"
                rows={22}
                value={editor}
                onChange={(e) => setEditor(e.target.value)}
                spellCheck={false}
              />
            </Field>
          </ActionForm>
        </Modal>
      ) : null}
      {view ? (
        <Modal
          title={view.name + " · v" + view.version}
          onClose={() => setView(undefined)}
          wide
        >
          <Json value={view.definition} />
          <div className="form-actions">
            <CopyButton value={pretty(view.definition)} />
            {me.role === "admin" ? (
              <button
                className="primary"
                onClick={() => {
                  setEditor(pretty(view.definition));
                  setView(undefined);
                }}
              >
                Create next version
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {run ? (
        <RunModal operation={run} onClose={() => setRun(undefined)} />
      ) : null}
    </>
  );
}
function Approvals({ me }: { me: Me }) {
  const list = useData<{ items: Approval[] }>("/api/v1/approvals"),
    [review, setReview] = useState<Approval>(),
    [decision, setDecision] = useState("APPROVED"),
    [reason, setReason] = useState(""),
    [showAll, setShowAll] = useState(false);
  const rows =
    list.data?.items.filter((a) => showAll || a.status === "PENDING") || [];
  return (
    <>
      <SectionTitle
        title="Action approvals"
        description="Review the exact action and payload before it reaches an external system."
      />
      <div className="toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />{" "}
          Include decided approvals
        </label>
        <button className="secondary" onClick={list.refresh}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      <ErrorBox>{list.error}</ErrorBox>
      {list.loading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty title="No pending decisions">
          Operations that require approval will appear here before dispatch.
        </Empty>
      ) : (
        rows.map((a) => (
          <article className="panel approval-card" key={a.id}>
            <div className="approval-icon">
              <ShieldCheck />
            </div>
            <div className="approval-main">
              <div className="step-heading">
                <div>
                  <h2>{a.operation_name}</h2>
                  <p>
                    Step {a.step_id} · Requested {date(a.created_at)}
                  </p>
                </div>
                <Badge status={a.status} />
              </div>
              <p className="digest">
                Digest <code>{a.digest}</code>
              </p>
              <details>
                <summary>Exact action payload</summary>
                <Json value={a.resolved} />
              </details>
              {a.reason ? (
                <p className="muted">Decision reason: {a.reason}</p>
              ) : null}
              <div className="card-actions">
                <a href={"#/runs/" + a.run_id} className="text-button">
                  Open run <ArrowUpRight size={14} />
                </a>
                {a.status === "PENDING" &&
                ["admin", "reviewer"].includes(me.role) ? (
                  <button className="primary" onClick={() => setReview(a)}>
                    Review action
                  </button>
                ) : null}
              </div>
            </div>
          </article>
        ))
      )}
      {review ? (
        <Modal title="Review action" onClose={() => setReview(undefined)} wide>
          <Json value={review.resolved} />
          {me.workspace.two_person_approval &&
          review.requested_by === me.keyId ? (
            <ErrorBox>
              A different API identity must approve this operation.
            </ErrorBox>
          ) : (
            <ActionForm
              label="Record decision"
              onSubmit={async () => {
                await send("/api/v1/approvals/" + review.id + "/decision", {
                  decision,
                  reason,
                });
                setReview(undefined);
                setReason("");
                list.refresh();
              }}
            >
              <Field label="Decision">
                <select
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                >
                  <option value="APPROVED">Approve this exact action</option>
                  <option value="REJECTED">Reject and stop the run</option>
                </select>
              </Field>
              <Field label="Reason">
                <textarea
                  required
                  minLength={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Explain your decision"
                />
              </Field>
            </ActionForm>
          )}
        </Modal>
      ) : null}
    </>
  );
}
function Connections({ me }: { me: Me }) {
  const list = useData<{ items: Connector[] }>("/api/v1/connectors"),
    [create, setCreate] = useState(false),
    [rotate, setRotate] = useState<Connector>(),
    [name, setName] = useState(""),
    [kind, setKind] = useState("http"),
    [url, setUrl] = useState(""),
    [secrets, setSecrets] = useState("{}"),
    [headers, setHeaders] = useState("{}"),
    [idempotency, setIdempotency] = useState("");
  return (
    <>
      <SectionTitle
        title="Connections"
        description="Scoped access to APIs, browser portals and model providers."
      >
        {me.role === "admin" ? (
          <button
            className="primary"
            onClick={() => {
              setSecrets("{}");
              setCreate(true);
            }}
          >
            <Plus size={16} /> Add connection
          </button>
        ) : null}
      </SectionTitle>
      <div className="info-banner compact-banner">
        <ShieldCheck size={20} />
        <p>
          Only platform-approved origins are allowed. Secret headers are
          encrypted at rest and are never returned by this API.
        </p>
      </div>
      <ErrorBox>{list.error}</ErrorBox>
      <div className="operation-grid">
        {list.data?.items.map((c) => (
          <article className="panel operation-card" key={c.id}>
            <div className="operation-top">
              <div className="operation-icon">
                <Unplug size={22} />
              </div>
              <span className="version">{c.kind}</span>
            </div>
            <h2>{c.name}</h2>
            <code className="connection-url">{c.base_url}</code>
            <p>
              {c.has_secrets
                ? "Encrypted credentials configured"
                : "No secret headers"}
              {c.idempotency_header ? (
                <>
                  <br />
                  Idempotency header: {c.idempotency_header}
                </>
              ) : null}
            </p>
            {me.role === "admin" ? (
              <button
                className="secondary"
                onClick={() => {
                  setSecrets("{}");
                  setRotate(c);
                }}
              >
                <KeyRound size={15} /> Rotate credentials
              </button>
            ) : null}
          </article>
        ))}
      </div>
      {list.loading ? (
        <Loading />
      ) : list.data && !list.data.items.length ? (
        <Empty title="No connections yet">
          Add a provider before publishing API, browser or model steps.
        </Empty>
      ) : null}
      {create ? (
        <Modal title="Add connection" onClose={() => setCreate(false)}>
          <ActionForm
            label="Create connection"
            onSubmit={async () => {
              await send("/api/v1/connectors", {
                name,
                kind,
                baseUrl: url,
                headers: JSON.parse(headers),
                secretHeaders: JSON.parse(secrets),
                idempotencyHeader: idempotency || undefined,
              });
              setCreate(false);
              setSecrets("{}");
              list.refresh();
            }}
          >
            <div className="two-columns">
              <Field label="Name">
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="supplier-api"
                />
              </Field>
              <Field label="Executor type">
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="http">HTTP API</option>
                  <option value="browser">Browser</option>
                  <option value="model">Model provider</option>
                </select>
              </Field>
            </div>
            <Field
              label="Base URL"
              help="For model providers, include the API path and trailing slash, for example /v1/."
            >
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/"
              />
            </Field>
            <details>
              <summary>Approved origins</summary>
              <Json value={me.allowedOrigins} />
              <small>
                Update ALLOWED_ORIGINS on the server to add providers.
              </small>
            </details>
            <Field label="Public headers JSON">
              <textarea
                className="code-editor"
                rows={3}
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
              />
            </Field>
            <Field
              label="Secret headers JSON"
              help="Stored encrypted. Use this for Authorization and API keys."
            >
              <textarea
                className="code-editor"
                rows={4}
                value={secrets}
                onChange={(e) => setSecrets(e.target.value)}
                placeholder={'{"Authorization":"Bearer …"}'}
                autoComplete="off"
              />
            </Field>
            {kind === "http" ? (
              <Field
                label="Provider idempotency header (optional)"
                help="Configure only if the provider guarantees deduplication for this header."
              >
                <input
                  value={idempotency}
                  onChange={(e) => setIdempotency(e.target.value)}
                  placeholder="Idempotency-Key"
                />
              </Field>
            ) : null}
          </ActionForm>
        </Modal>
      ) : null}
      {rotate ? (
        <Modal
          title={"Rotate credentials · " + rotate.name}
          onClose={() => setRotate(undefined)}
        >
          <ActionForm
            label="Replace credentials"
            onSubmit={async () => {
              await send(
                "/api/v1/connectors/" + rotate.id + "/credentials",
                { secretHeaders: JSON.parse(secrets) },
                "PUT",
              );
              setRotate(undefined);
              setSecrets("{}");
              list.refresh();
            }}
          >
            <p>
              This replaces all secret headers. New requests use the
              replacement; requests already sent are unaffected.
            </p>
            <Field label="Replacement secret headers JSON">
              <textarea
                rows={6}
                className="code-editor"
                value={secrets}
                onChange={(e) => setSecrets(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </ActionForm>
        </Modal>
      ) : null}
    </>
  );
}
function UsageView({ canReview }: { canReview: boolean }) {
  const usage = useData<Usage>("/api/v1/usage"),
    events = useData<{ items: Event[] }>("/api/v1/events"),
    [audit, setAudit] = useState<{
      valid: boolean;
      events?: number;
      head?: string;
      firstInvalidEvent?: string;
    }>(),
    [error, setError] = useState("");
  const u = usage.data?.usage,
    total = usage.data?.runs.reduce((n, r) => n + r.count, 0) || 0;
  return (
    <>
      <SectionTitle
        title="Usage & audit"
        description="Measured executor activity and an integrity check for workspace events."
      />
      <ErrorBox>{usage.error || events.error || error}</ErrorBox>
      <div className="metrics">
        <Metric
          label="HTTP requests"
          value={u?.http_requests || 0}
          icon={<Unplug />}
          hint="Execution plus verification"
        />
        <Metric
          label="Model tokens"
          value={Number(u?.input_tokens || 0) + Number(u?.output_tokens || 0)}
          icon={<Blocks />}
          hint="Reported by the model provider"
        />
        <Metric
          label="Browser seconds"
          value={Math.round(Number(u?.browser_ms || 0) / 1000)}
          icon={<Clock3 />}
          hint="Recorded browser execution time"
        />
        <Metric
          label="Attempts"
          value={u?.attempts || 0}
          icon={<Activity />}
          hint="Includes retries and verification"
        />
      </div>
      <div className="two-columns">
        <section className="panel">
          <h2>Run outcomes</h2>
          <p className="muted">All recorded runs in this workspace.</p>
          {usage.data?.runs.map((r) => (
            <div className="outcome-row" key={r.status}>
              <div>
                <Badge status={r.status} />
                <strong>{number(r.count)}</strong>
              </div>
              <div className="bar-track">
                <div
                  style={{ width: (total ? (r.count / total) * 100 : 0) + "%" }}
                />
              </div>
            </div>
          ))}
          {!total ? <Empty title="No usage recorded yet" /> : null}
        </section>
        <section className="panel">
          <h2>Audit chain integrity</h2>
          <p>
            Check that events still match the stored hash chain. This detects
            alterations within the retained chain; database administrators can
            rewrite an entire chain.
          </p>
          <button
            className="secondary"
            disabled={!canReview}
            title={
              canReview
                ? "Verify retained audit records"
                : "Administrator or reviewer access required"
            }
            onClick={() =>
              void api<{ valid: boolean; events?: number; head?: string }>(
                "/api/v1/audit/verify",
              )
                .then(setAudit)
                .catch((e) => setError(e.message))
            }
          >
            <ShieldCheck size={16} /> Verify audit chain
          </button>
          {audit ? (
            <div className={audit.valid ? "success-box" : "error-box"}>
              <strong>
                {audit.valid ? "Chain verified" : "Integrity check failed"}
              </strong>
              <p>
                {audit.valid
                  ? number(audit.events || 0) + " events verified"
                  : "First invalid event: " + audit.firstInvalidEvent}
              </p>
              {audit.head ? <code className="digest">{audit.head}</code> : null}
            </div>
          ) : null}
          <p className="footnote">
            Usage counters are operational measurements. They are not a provider
            invoice or a billing-grade exactly-once meter.
          </p>
        </section>
      </div>
      <section className="panel">
        <h2>Workspace events</h2>
        {events.data?.items.slice(0, 40).map((e) => (
          <details className="event-detail" key={e.id}>
            <summary>
              <strong>{e.type}</strong>
              <span>{date(e.created_at)}</span>
            </summary>
            <Json value={e.data} />
          </details>
        ))}
      </section>
    </>
  );
}
function SettingsView({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const keys = useData<{ items: Key[] }>(
      me.role === "admin" ? "/api/v1/keys" : undefined,
    ),
    [name, setName] = useState(me.workspace.name),
    [daily, setDaily] = useState(me.workspace.max_runs_per_day),
    [concurrent, setConcurrent] = useState(me.workspace.max_concurrent_runs),
    [twoPerson, setTwoPerson] = useState(me.workspace.two_person_approval),
    [keyName, setKeyName] = useState(""),
    [role, setRole] = useState("operator"),
    [created, setCreated] = useState<{ token: string }>(),
    [revoke, setRevoke] = useState<Key>(),
    [saved, setSaved] = useState(false);
  if (me.role !== "admin")
    return (
      <>
        <SectionTitle title="Workspace settings" />
        <section className="panel">
          <h2>{me.workspace.name}</h2>
          <p>
            Your role: {me.role}. Workspace administrators manage keys and
            limits.
          </p>
        </section>
      </>
    );
  return (
    <>
      <SectionTitle
        title="Workspace settings"
        description="Manage access, separation of duties and execution limits."
      />
      <div className="two-columns">
        <section className="panel">
          <h2>Workspace policy</h2>
          <ActionForm
            label="Save settings"
            onSubmit={async () => {
              await send(
                "/api/v1/workspace",
                {
                  name,
                  maxRunsPerDay: daily,
                  maxConcurrentRuns: concurrent,
                  twoPersonApproval: twoPerson,
                },
                "PATCH",
              );
              await reload();
              setSaved(true);
            }}
          >
            <Field label="Workspace name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="two-columns">
              <Field label="Daily run limit">
                <input
                  required
                  type="number"
                  min="1"
                  max="1000000"
                  value={daily}
                  onChange={(e) => setDaily(Number(e.target.value))}
                />
              </Field>
              <Field label="Concurrent runs">
                <input
                  required
                  type="number"
                  min="1"
                  max="1000"
                  value={concurrent}
                  onChange={(e) => setConcurrent(Number(e.target.value))}
                />
              </Field>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={twoPerson}
                onChange={(e) => setTwoPerson(e.target.checked)}
              />{" "}
              Require a separate identity for approvals and manual resolutions
            </label>
            <p className="footnote">
              Separation is enforced by API-key identity. Assign individual keys
              to reviewers; administrators can still create keys and change this
              policy.
            </p>
            {saved ? <div className="success-box">Settings saved.</div> : null}
          </ActionForm>
        </section>
        <section className="panel">
          <h2>Create an API key</h2>
          <ActionForm
            label="Create key"
            onSubmit={async () => {
              setCreated(await send("/api/v1/keys", { name: keyName, role }));
              setKeyName("");
              keys.refresh();
            }}
          >
            <Field label="Key name">
              <input
                required
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="Order processing service"
              />
            </Field>
            <Field label="Role">
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="operator">
                  Operator — submit, cancel and reconcile
                </option>
                <option value="reviewer">Reviewer — approve and resolve</option>
                <option value="viewer">Viewer — read workspace data</option>
                <option value="admin">
                  Administrator — full workspace access
                </option>
              </select>
            </Field>
          </ActionForm>
          {created ? (
            <div className="token-reveal">
              <strong>Copy this key now</strong>
              <p>It cannot be retrieved later.</p>
              <code>{created.token}</code>
              <CopyButton value={created.token} />
            </div>
          ) : null}
        </section>
      </div>
      <section className="panel">
        <h2>API keys</h2>
        <ErrorBox>{keys.error}</ErrorBox>
        {keys.data?.items.map((k) => (
          <div className="list-row" key={k.id}>
            <div>
              <strong>
                {k.name}{" "}
                {k.id === me.keyId ? (
                  <span className="version">Current</span>
                ) : null}
              </strong>
              <small>
                {k.role} · Created {date(k.created_at)}
              </small>
            </div>
            {k.revoked_at ? (
              <Badge status="REVOKED" />
            ) : (
              <button
                className="secondary danger-text"
                disabled={k.id === me.keyId}
                onClick={() => setRevoke(k)}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </section>
      {revoke ? (
        <Modal title="Revoke API key" onClose={() => setRevoke(undefined)}>
          <ActionForm
            label="Revoke key"
            onSubmit={async () => {
              await api("/api/v1/keys/" + revoke.id, { method: "DELETE" });
              setRevoke(undefined);
              keys.refresh();
            }}
          >
            <p>
              Access through <strong>{revoke.name}</strong> will stop
              immediately, including browser sessions using this key.
            </p>
          </ActionForm>
        </Modal>
      ) : null}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
