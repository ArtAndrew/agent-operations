import {
  useEffect,
  useRef,
  useState,
  useId,
  isValidElement,
  cloneElement,
  type ReactNode,
  type FormEvent,
} from "react";
import { X, Copy, Check, LoaderCircle, Inbox } from "lucide-react";
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export const short = (id: string) => id.slice(0, 8);
export const date = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
export const number = (value: number | string) =>
  new Intl.NumberFormat("en-US").format(Number(value));
export function Badge({ status }: { status: string }) {
  return (
    <span className={"badge " + status.toLowerCase()}>
      <span />
      {status.toLowerCase().replaceAll("_", " ")}
    </span>
  );
}
export function ErrorBox({ children }: { children?: ReactNode }) {
  return children ? (
    <div role="alert" className="error-box">
      {children}
    </div>
  ) : null;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Inbox size={28} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={20} /> Loading workspace data
    </div>
  );
}
export function Json({ value }: { value: unknown }) {
  return <pre className="json">{pretty(value)}</pre>;
}
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <button
      className="icon-button"
      aria-label={copied ? "Copied" : "Copy"}
      title={
        copied
          ? "Copied"
          : failed
            ? "Copy failed; select the text manually"
            : "Copy"
      }
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          },
          () => setFailed(true),
        );
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      className={wide ? "wide" : ""}
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function ActionForm({
  onSubmit,
  children,
  label = "Save",
  secondary,
}: {
  onSubmit: () => Promise<void>;
  children: ReactNode;
  label?: string;
  secondary?: ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)}>
      <fieldset disabled={busy}>
        {children}
        <ErrorBox>{error}</ErrorBox>
        <div className="form-actions">
          {secondary}
          <button className="primary" type="submit">
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            {busy ? "Working…" : label}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const element = isValidElement<{ id?: string; "aria-describedby"?: string }>(
    children,
  )
    ? children
    : undefined;
  const id = element?.props.id || generatedId;
  const control = element
    ? cloneElement(element, {
        id,
        "aria-describedby": help
          ? id + "-help"
          : element.props["aria-describedby"],
      })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {help ? <small id={id + "-help"}>{help}</small> : null}
    </div>
  );
}
export function SectionTitle({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="section-actions">{children}</div>
    </div>
  );
}
