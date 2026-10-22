import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
export interface Config {
  host: string;
  port: number;
  dataDir: string;
  databaseUrl?: string;
  masterKey: Buffer;
  adminToken: string;
  allowedOrigins: Set<string>;
  allowPrivateNetwork: boolean;
  concurrency: number;
  leaseMs: number;
  pollMs: number;
  webDir: string;
  publicOrigin?: string;
  s3?: { bucket: string; region: string; endpoint?: string };
}
export async function config(overrides: Partial<Config> = {}): Promise<Config> {
  const dataDir = resolve(overrides.dataDir || process.env.DATA_DIR || ".data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let local: { masterKey: string; adminToken: string } | undefined;
  if (
    (!overrides.masterKey && !process.env.MASTER_KEY) ||
    (!overrides.adminToken && !process.env.ADMIN_TOKEN)
  ) {
    if (process.env.NODE_ENV === "production")
      throw new Error("MASTER_KEY and ADMIN_TOKEN must be set in production");
    try {
      local = JSON.parse(
        await readFile(resolve(dataDir, "local-secrets.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      local = {
        masterKey: randomBytes(32).toString("hex"),
        adminToken: randomBytes(32).toString("base64url"),
      };
      await writeFile(
        resolve(dataDir, "local-secrets.json"),
        JSON.stringify(local),
        { mode: 0o600, flag: "wx" },
      );
    }
  }
  const key =
    overrides.masterKey?.toString("hex") ||
    process.env.MASTER_KEY ||
    local!.masterKey;
  if (!/^[0-9a-f]{64}$/i.test(key))
    throw new Error("MASTER_KEY must contain 64 hexadecimal characters");
  const result: Config = {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 4300),
    dataDir,
    databaseUrl: process.env.DATABASE_URL,
    masterKey: Buffer.from(key, "hex"),
    adminToken:
      overrides.adminToken || process.env.ADMIN_TOKEN || local!.adminToken,
    allowedOrigins: new Set(
      (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .filter(Boolean)
        .map((v) => new URL(v).origin),
    ),
    allowPrivateNetwork: process.env.ALLOW_PRIVATE_NETWORK === "true",
    concurrency: Number(process.env.WORKER_CONCURRENCY || 4),
    leaseMs: 30000,
    pollMs: 500,
    webDir: resolve("web-dist"),
    publicOrigin: process.env.PUBLIC_ORIGIN
      ? new URL(process.env.PUBLIC_ORIGIN).origin
      : undefined,
    ...overrides,
  };
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535)
    throw new Error("Invalid PORT");
  if (result.adminToken.length < 32 || result.adminToken.length > 512)
    throw new Error("ADMIN_TOKEN must contain 32–512 characters");
  if (
    !Number.isInteger(result.concurrency) ||
    result.concurrency < 1 ||
    result.concurrency > 64
  )
    throw new Error("WORKER_CONCURRENCY must be between 1 and 64");
  if (process.env.S3_BUCKET)
    result.s3 = {
      bucket: process.env.S3_BUCKET,
      region: process.env.AWS_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
    };
  return result;
}
