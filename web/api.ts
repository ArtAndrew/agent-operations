import { useEffect, useState, useCallback } from "react";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error?.code || "REQUEST_FAILED",
      data.error?.message || "Request failed",
    );
  return data as T;
}
export const send = <T>(
  path: string,
  body: unknown,
  method = "POST",
  headers?: Record<string, string>,
) => api<T>(path, { method, headers, body: JSON.stringify(body) });
export function useData<T>(path: string | undefined, interval = 5000) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    let alive = true,
      controller: AbortController | undefined;
    setLoading(true);
    setData(undefined);
    setError("");
    const load = async () => {
      controller = new AbortController();
      try {
        const value = await api<T>(path, { signal: controller.signal });
        if (alive) {
          setData(value);
          setError("");
        }
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === "AbortError"))
          setError(e instanceof Error ? e.message : "Request failed");
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = interval
      ? setInterval(() => void load(), interval)
      : undefined;
    return () => {
      alive = false;
      controller?.abort();
      if (timer) clearInterval(timer);
    };
  }, [path, interval, revision]);
  return { data, error, loading, refresh };
}
