import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve("."),
  packages = new Map(),
  texts = new Map();
async function locate(name, from) {
  let directory = from;
  while (true) {
    const candidate = join(directory, "node_modules", name);
    try {
      await readFile(join(candidate, "package.json"));
      return await realpath(candidate);
    } catch {}
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Cannot locate dependency " + name);
    directory = parent;
  }
}
async function visit(name, from, optional = false) {
  let directory;
  try {
    directory = await locate(name, from);
  } catch (error) {
    if (optional) return;
    throw error;
  }
  const metadata = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  const identity = metadata.name + "@" + metadata.version;
  if (packages.has(identity)) return;
  const license =
    typeof metadata.license === "string"
      ? metadata.license
      : metadata.license?.type || "Unspecified";
  packages.set(identity, {
    name: metadata.name,
    version: metadata.version,
    license,
  });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name)
    )
      continue;
    const content = await readFile(join(directory, entry.name), "utf8"),
      digest = createHash("sha256").update(content).digest("hex");
    const existing = texts.get(digest) || { content, packages: new Set() };
    existing.packages.add(identity);
    texts.set(digest, existing);
  }
  for (const dependency of Object.keys(metadata.dependencies || {}))
    await visit(dependency, directory);
  for (const dependency of Object.keys(metadata.optionalDependencies || {}))
    await visit(dependency, directory, true);
}
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const name of Object.keys(manifest.dependencies)) await visit(name, root);
const rows = [...packages.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
let output =
  "# Third-party notices\n\nGenerated from the installed production dependency graph. These components retain their original licenses. Browser binaries and operating-system packages retain the notices included in their own distributions. Regenerate with node scripts/generate-notices.mjs after dependency changes.\n\n| Component | Version | Declared license |\n| --- | --- | --- |\n";
for (const row of rows)
  output +=
    "| [" +
    row.name +
    "](https://www.npmjs.com/package/" +
    encodeURIComponent(row.name) +
    ") | " +
    row.version +
    " | " +
    row.license +
    " |\n";
output += "\n## License and notice texts\n";
for (const entry of texts.values())
  output +=
    "\n### " +
    [...entry.packages].sort().join(", ") +
    "\n\n~~~~text\n" +
    entry.content
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .trim() +
    "\n~~~~\n";
await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), output);
console.log(
  "Recorded " +
    packages.size +
    " production packages and " +
    texts.size +
    " distinct notice texts.",
);
const missing = rows.filter((row) => row.license === "Unspecified");
if (missing.length) {
  console.error(
    "Review packages with unspecified licenses:",
    missing.map((p) => p.name),
  );
  process.exitCode = 1;
}
