import { it, expect } from "vitest";
import { Network } from "../src/network.js";
import type { Config } from "../src/config.js";
import { resolve, checkAssertions } from "../src/util.js";
const network = new Network({
  allowedOrigins: new Set([
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://example.com",
  ]),
  allowPrivateNetwork: false,
} as Config);
it("rejects metadata, loopback, unknown origins and URL credentials", async () => {
  for (const url of [
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://attacker.example",
    "https://user:password@example.com",
  ]) {
    await expect(network.target(url)).rejects.toBeDefined();
  }
  expect(() =>
    network.path("https://example.com/", "https://attacker.example"),
  ).toThrow();
  expect(() =>
    network.path("https://example.com/", "//attacker.example"),
  ).toThrow();
});
it("resolves structured references without eval or prototype traversal", () => {
  expect(
    resolve(
      { body: "{{ input }}", title: "Order {{ input.id }}" },
      { input: { id: 5 } },
    ),
  ).toEqual({ body: { id: 5 }, title: "Order 5" });
  expect(() => resolve("{{ input.__proto__ }}", { input: {} })).toThrow();
  expect(() => resolve("{{ missing }}", {})).toThrow();
  expect(
    checkAssertions({ id: 2 }, [{ path: "id", operator: "equals", value: 3 }]),
  ).toHaveLength(1);
});
