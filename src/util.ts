import {
  createHash,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import AjvModule from "ajv";
import { AppError, type Assertion } from "./domain.js";
const Ajv = AjvModule as unknown as {
  new (options?: Record<string, unknown>): {
    compile: (
      schema: unknown,
    ) => ((data: unknown) => boolean) & { errors?: unknown };
  };
};
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
export const newToken = () => "aok_" + randomBytes(32).toString("base64url");
export function equalToken(a: string, b: string) {
  const aa = Buffer.from(hash(a)),
    bb = Buffer.from(hash(b));
  return timingSafeEqual(aa, bb);
}
export function encrypt(value: unknown, key: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const out = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), out]).toString("base64");
}
export function decrypt(value: string, key: Buffer): Record<string, string> {
  const b = Buffer.from(value, "base64"),
    dec = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  dec.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([dec.update(b.subarray(28)), dec.final()]).toString(),
  );
}
export function at(value: unknown, path: string): unknown {
  if (!path || path === "$") return value;
  const parts = path.replace(/^\$\.?/, "").split(".");
  let current: unknown = value;
  for (const part of parts) {
    if (["__proto__", "prototype", "constructor"].includes(part))
      throw new AppError(400, "INVALID_PATH", "Unsafe data path");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
export function resolve<T>(value: T, context: Record<string, unknown>): T {
  if (typeof value === "string") {
    const full = value.match(/^\{\{\s*([\w.$-]+)\s*\}\}$/);
    if (full) {
      const v = at(context, full[1]!);
      if (v === undefined)
        throw new AppError(
          400,
          "UNRESOLVED_REFERENCE",
          "Missing reference: " + full[1],
        );
      return structuredClone(v) as T;
    }
    return value.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, path) => {
      const v = at(context, path);
      if (v === undefined || typeof v === "object")
        throw new AppError(
          400,
          "UNRESOLVED_REFERENCE",
          "Expected scalar reference: " + path,
        );
      return String(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, context)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, context)]),
    ) as T;
  return value;
}
export function validateInput(schema: unknown, data: unknown) {
  const serialized = JSON.stringify(schema);
  if (serialized.length > 50000 || /"\$ref"\s*:\s*"(?!#)/.test(serialized))
    throw new AppError(
      400,
      "INVALID_SCHEMA",
      "External schema references and oversized schemas are not supported",
    );
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch {
    throw new AppError(400, "INVALID_SCHEMA", "Invalid JSON Schema");
  }
  if (!validate(data))
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      JSON.stringify(validate.errors),
    );
}
export function checkAssertions(
  value: unknown,
  assertions: Assertion[],
): string[] {
  return assertions.flatMap((a) => {
    const actual = at(value, a.path);
    const ok =
      a.operator === "exists"
        ? actual !== undefined && actual !== null
        : a.operator === "equals"
          ? canonical(actual) === canonical(a.value)
          : a.operator === "contains"
            ? typeof actual === "string"
              ? actual.includes(String(a.value))
              : Array.isArray(actual) &&
                actual.some((v) => canonical(v) === canonical(a.value))
            : a.operator === "greaterThan"
              ? typeof actual === "number" &&
                typeof a.value === "number" &&
                actual > a.value
              : typeof actual === "number" &&
                typeof a.value === "number" &&
                actual < a.value;
    return ok ? [] : [a.path + " " + a.operator + " assertion failed"];
  });
}
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export function safeError(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 2000)
    : "Unexpected error";
}
