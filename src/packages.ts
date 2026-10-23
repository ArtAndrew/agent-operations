import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { Github } from "./github.js";
import { AppError, type Identity, type Operation } from "./domain.js";
import { decrypt, encrypt } from "./util.js";

export const PackageConfig = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/),
  connection: z.string().min(1),
  owner: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  repo: z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/),
  requireApproval: z.boolean().default(true),
  waitForCompleted: z.boolean().default(false),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  maxWaitHours: z.number().int().min(1).max(720).default(168),
});
export const catalog = [
  {
    id: "github-issues",
    version: "0.2.0",
    name: "GitHub issues",
    description:
      "Create a verified issue for a case; optionally wait for completed closure. GitHub.com personal access tokens only.",
    configurationSchema: z.toJSONSchema(PackageConfig),
  },
];
export interface Installation {
  id: string;
  workspace_id: string;
  package_id: string;
  package_version: string;
  operation_id: string;
  connection_id: string;
  config: z.infer<typeof PackageConfig>;
  webhook_secret: string;
}

export function githubOperation(
  input: z.infer<typeof PackageConfig>,
): Operation {
  const target = {
    connection: input.connection,
    owner: input.owner,
    repo: input.repo,
    caseId: "{{ input.caseId }}",
  };
  const verification = {
    kind: "github_issue" as const,
    ...target,
    title: "{{ input.title }}",
    body: "{{ input.body }}",
    waitForCompleted: false,
  };
  const common = {
    kind: "github_issue" as const,
    ...target,
    issueTitle: "{{ input.title }}",
    body: "{{ input.body }}",
    timeoutMs: 30000,
    retry: { maxAttempts: 3, delayMs: 1000 },
  };
  return {
    name: input.name,
    description:
      "Create a GitHub issue for a stable case ID, verify its creation" +
      (input.waitForCompleted
        ? " and wait for it to be closed as completed."
        : "."),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["caseId", "title", "body"],
      properties: {
        caseId: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", maxLength: 60000 },
      },
    },
    steps: [
      {
        ...common,
        id: "create_issue",
        title: "Create and verify issue",
        action: "create",
        effect: "write",
        businessKey: "{{ input.caseId }}",
        approval: input.requireApproval,
        verify: verification,
        recheck: { intervalMs: input.pollSeconds * 1000, maxWaitMs: 3600000 },
      },
      ...(input.waitForCompleted
        ? [
            {
              ...common,
              id: "wait_completed",
              title: "Wait for completed closure",
              action: "wait" as const,
              effect: "read" as const,
              approval: false,
              verify: {
                ...verification,
                number: "{{ steps.create_issue.number }}",
                waitForCompleted: true,
              },
              recheck: {
                intervalMs: input.pollSeconds * 1000,
                maxWaitMs: input.maxWaitHours * 3600000,
              },
            },
          ]
        : []),
    ],
  };
}
export class Packages {
  constructor(private store: Store) {}
  async list(workspace: string) {
    const result = await this.store.db.query(
      `SELECT p.id,p.package_id,p.package_version,p.config,p.created_at,o.name AS operation_name,o.version AS operation_version
      FROM package_installations p JOIN operations o ON o.id=p.operation_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC`,
      [workspace],
    );
    return { catalog, items: result.rows };
  }
  async check(identity: Identity, raw: unknown) {
    const config = PackageConfig.parse(raw);
    const connection = await this.store.connector(
      identity.workspaceId,
      config.connection,
    );
    const url = new URL(connection.base_url);
    if (
      connection.kind !== "http" ||
      (url.origin !== "https://api.github.com" &&
        !(
          this.store.config.allowPrivateNetwork &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new AppError(
        400,
        "GITHUB_ORIGIN",
        "Use an HTTP connection to https://api.github.com",
      );
    const github = new Github(this.store);
    const user = z
      .object({ id: z.number(), login: z.string() })
      .parse(
        (await github.request(connection, "/user", AbortSignal.timeout(15000)))
          .body,
      );
    const repo = z
      .object({
        id: z.number(),
        full_name: z.string(),
        has_issues: z.boolean(),
      })
      .parse(
        (
          await github.request(
            connection,
            `/repos/${config.owner}/${config.repo}`,
            AbortSignal.timeout(15000),
          )
        ).body,
      );
    if (
      !repo.has_issues ||
      repo.full_name.toLowerCase() !==
        `${config.owner}/${config.repo}`.toLowerCase()
    )
      throw new AppError(
        400,
        "REPOSITORY_UNAVAILABLE",
        "Repository must match exactly and have issues enabled",
      );
    return {
      ok: true,
      account: user.login,
      accountId: user.id,
      repository: repo.full_name,
      repositoryId: repo.id,
      note: "Read access verified. Issue write permission is confirmed only by a real operation.",
    };
  }
  async install(identity: Identity, raw: unknown) {
    const config = PackageConfig.parse(raw);
    const check = await this.check(identity, config);
    const id = randomUUID(),
      secret = randomBytes(32).toString("hex");
    const operation = await this.store.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        identity.workspaceId,
      ]);
      if (
        (
          await tx.query(
            "SELECT id FROM operations WHERE workspace_id=$1 AND name=$2",
            [identity.workspaceId, config.name],
          )
        ).rows.length
      )
        throw new AppError(
          409,
          "OPERATION_EXISTS",
          "Choose an unused operation name; installations are immutable",
        );
      const connector = await this.store.connector(
        identity.workspaceId,
        config.connection,
        tx,
      );
      const op = await this.store.register(
        identity,
        githubOperation({ ...config, connection: connector.id }),
        tx,
      );
      await tx.query(
        "INSERT INTO package_installations(id,workspace_id,package_id,package_version,operation_id,connection_id,config,webhook_secret) VALUES($1,$2,'github-issues','0.2.0',$3,$4,$5::jsonb,$6)",
        [
          id,
          identity.workspaceId,
          op.id,
          connector.id,
          JSON.stringify({ ...config, connection: connector.id }),
          encrypt({ secret }, this.store.config.masterKey),
        ],
      );
      await this.store.event(
        tx,
        identity.workspaceId,
        null,
        "package.installed",
        identity.keyId,
        {
          id,
          package: "github-issues",
          operation: config.name,
          repository: check.repository,
        },
      );
      return op;
    });
    return {
      id,
      operation,
      connectionCheck: check,
      webhook: {
        path: `/hooks/github/${id}`,
        secret,
        instructions:
          "Configure an application/json repository webhook for Issues events. This secret is shown once. Polling works without a webhook.",
      },
    };
  }
  async webhook(
    id: string,
    raw: Buffer,
    signature: string,
    delivery: string,
    event: string,
  ) {
    const p = (
      await this.store.db.query<Installation>(
        "SELECT * FROM package_installations WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!p) throw new AppError(404, "NOT_FOUND", "Webhook not found");
    const secret = decrypt(
      p.webhook_secret,
      this.store.config.masterKey,
    ).secret!;
    const expected = Buffer.from(
      "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
    );
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new AppError(401, "INVALID_SIGNATURE", "Invalid webhook signature");
    z.string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9-]+$/)
      .parse(delivery);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AppError(400, "INVALID_JSON", "Invalid webhook JSON");
    }
    if (event === "ping") return { accepted: true };
    const payload = z
      .object({ repository: z.object({ full_name: z.string() }) })
      .safeParse(body);
    if (
      event !== "issues" ||
      !payload.success ||
      payload.data.repository.full_name.toLowerCase() !==
        `${p.config.owner}/${p.config.repo}`.toLowerCase()
    )
      throw new AppError(
        400,
        "WRONG_EVENT",
        "Expected an issues event for the installed repository",
      );
    return this.store.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        p.workspace_id,
      ]);
      const inserted = await tx.query(
        "INSERT INTO webhook_deliveries(installation_id,delivery_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING delivery_id",
        [id, delivery],
      );
      if (!inserted.rows.length) return { accepted: true, duplicate: true };
      // Events are wake-up hints, never authoritative evidence. Re-read GitHub.
      const woken = await tx.query(
        "UPDATE runs SET available_at=now() WHERE workspace_id=$1 AND operation_id=$2 AND status='WAITING_EXTERNAL' RETURNING id",
        [p.workspace_id, p.operation_id],
      );
      await this.store.event(
        tx,
        p.workspace_id,
        null,
        "package.webhook",
        "github",
        { installationId: id, delivery, event, woken: woken.rows.length },
      );
      return { accepted: true, duplicate: false };
    });
  }
}
