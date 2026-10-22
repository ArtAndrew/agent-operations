import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { AppError } from "./domain.js";
export class Artifacts {
  close() {
    this.client?.destroy();
  }
  private client?: S3Client;
  constructor(
    private db: Database,
    private config: Config,
  ) {
    if (config.s3)
      this.client = new S3Client({
        region: config.s3.region,
        endpoint: config.s3.endpoint,
        forcePathStyle: !!config.s3.endpoint,
      });
  }
  async save(
    workspaceId: string,
    runId: string,
    stepId: string,
    artifact: { name: string; content: Buffer; contentType: string },
  ) {
    const id = randomUUID(),
      key = workspaceId + "/" + runId + "/" + id;
    if (this.client)
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.s3!.bucket,
          Key: key,
          Body: artifact.content,
          ContentType: artifact.contentType,
        }),
      );
    else {
      const directory = resolve(
        this.config.dataDir,
        "artifacts",
        workspaceId,
        runId,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(resolve(directory, id), artifact.content, {
        mode: 0o600,
      });
    }
    await this.db.query(
      "INSERT INTO artifacts(id,workspace_id,run_id,step_id,name,storage_key,content_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        workspaceId,
        runId,
        stepId,
        artifact.name,
        key,
        artifact.contentType,
        artifact.content.length,
        createHash("sha256").update(artifact.content).digest("hex"),
      ],
    );
    return id;
  }
  async read(workspaceId: string, id: string) {
    const result = await this.db.query<{
      storage_key: string;
      content_type: string;
      name: string;
    }>("SELECT * FROM artifacts WHERE workspace_id=$1 AND id=$2", [
      workspaceId,
      id,
    ]);
    const row = result.rows[0];
    if (!row) throw new AppError(404, "NOT_FOUND", "Artifact not found");
    let body: Buffer;
    if (this.client) {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.s3!.bucket,
          Key: row.storage_key,
        }),
      );
      body = Buffer.from(await result.Body!.transformToByteArray());
    } else
      body = await readFile(
        resolve(this.config.dataDir, "artifacts", row.storage_key),
      );
    return { body, contentType: row.content_type, name: row.name };
  }
}
