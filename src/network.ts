import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import type { Config } from "./config.js";
import { AppError, ExecutionError, emptyUsage } from "./domain.js";
export class Network {
  constructor(public config: Config) {}
  async target(raw: string, origin?: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError(400, "INVALID_URL", "Invalid outbound URL");
    }
    if (url.username || url.password || url.hash)
      throw new AppError(
        400,
        "INVALID_URL",
        "URL credentials and fragments are not allowed",
      );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (!this.config.allowPrivateNetwork && url.protocol !== "https:")
    )
      throw new AppError(
        403,
        "NETWORK_DENIED",
        "Unsupported outbound protocol",
      );
    if (
      !this.config.allowedOrigins.has(url.origin) ||
      (origin && url.origin !== origin)
    )
      throw new AppError(
        403,
        "NETWORK_DENIED",
        "Outbound origin is not permitted",
      );
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length)
      throw new AppError(400, "DNS_FAILURE", "Connector host did not resolve");
    if (
      !this.config.allowPrivateNetwork &&
      addresses.some(
        ({ address }) => ipaddr.process(address).range() !== "unicast",
      )
    )
      throw new AppError(
        403,
        "NETWORK_DENIED",
        "Private, loopback, link-local and reserved addresses are not permitted",
      );
    return { url, addresses };
  }
  path(base: string, path: string) {
    const origin = new URL(base).origin,
      url = new URL(path, base);
    if (url.origin !== origin)
      throw new AppError(
        403,
        "NETWORK_DENIED",
        "Request path cannot change connector origin",
      );
    return url.href;
  }
  async http(
    raw: string,
    options: {
      method: string;
      headers?: Record<string, string>;
      body?: unknown;
      signal: AbortSignal;
      write?: boolean;
    },
  ) {
    const { url, addresses } = await this.target(raw);
    const address = addresses[0]!;
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          const done = callback as (
            error: Error | null,
            address: unknown,
            family?: number,
          ) => void;
          if (typeof options === "object" && options.all) done(null, [address]);
          else done(null, address.address, address.family);
        },
      },
    });
    const usage = { ...emptyUsage(), httpRequests: 1 };
    try {
      const response = await request(url, {
        dispatcher,
        method: options.method as "GET",
        headers: options.headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        headersTimeout: 120000,
        bodyTimeout: 120000,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 2_000_000) {
          response.body.destroy();
          throw new ExecutionError(
            "Response exceeded the 2 MB limit",
            !!options.write,
            false,
            usage,
          );
        }
        chunks.push(bytes);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      if (response.statusCode >= 300 && response.statusCode < 400)
        throw new ExecutionError(
          "Redirects are not allowed for API requests",
          !!options.write,
          false,
          usage,
        );
      return { status: response.statusCode, body, usage };
    } catch (e) {
      if (e instanceof AppError || e instanceof ExecutionError) throw e;
      throw new ExecutionError(
        options.signal.aborted
          ? "Request timed out or was interrupted"
          : "Outbound request failed",
        !!options.write,
        true,
        usage,
      );
    } finally {
      await dispatcher.close();
    }
  }
}
