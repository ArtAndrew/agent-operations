import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const content =
  [
    "MASTER_KEY=" + randomBytes(32).toString("hex"),
    "ADMIN_TOKEN=" + randomBytes(32).toString("base64url"),
    "POSTGRES_PASSWORD=" + randomBytes(32).toString("base64url"),
    "PUBLIC_ORIGIN=http://127.0.0.1:4300",
    "ALLOWED_ORIGINS=",
    "WORKER_CONCURRENCY=4",
  ].join("\n") + "\n";
try {
  await writeFile(".env", content, { mode: 0o600, flag: "wx" });
  console.log(
    "Created .env with fresh secrets. Configure allowed provider origins before deployment.",
  );
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(".env already exists; it was not modified.");
    process.exitCode = 1;
  } else throw error;
}
