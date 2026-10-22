# Install from GitHub Release

[Release v0.1.0](https://github.com/ArtAndrew/agent-operations/releases/tag/v0.1.0) contains source, SDK archives, Linux Docker image archives, and `SHA256SUMS`. No package-registry account is needed. Source demo instructions are in the [quickstart](quickstart.md).

## Docker image

Download the image matching your Docker engine: `agent-operations-linux-amd64.tar.gz` for x86-64, or `agent-operations-linux-arm64.tar.gz` for ARM64, including Apple Silicon Docker Desktop. Verify the download against the release's `SHA256SUMS`, then load it:

```sh
docker load --input agent-operations-linux-arm64.tar.gz
```

The loaded tag is `agent-operations:0.1.0`. Both archives are built and checked on their native Linux architecture. To create a persistent local installation, from a clone of the repository:

```sh
node scripts/setup-env.mjs
# Edit .env: set allowed provider origins before adding connections.
docker compose -f compose.prebuilt.yaml up -d
docker compose -f compose.prebuilt.yaml exec api node dist/cli.js workspace "My workspace"
```

Save the initial workspace key and use it to sign in at <http://127.0.0.1:4300>. This starts an empty installation, not the demo supplier. The demo remains a loopback-only source command. Read [deployment](deployment.md) before exposing a service. The API and worker share PostgreSQL and an artifact volume; Docker also downloads the PostgreSQL base image.

## TypeScript SDK

```sh
npm install https://github.com/ArtAndrew/agent-operations/releases/download/v0.1.0/agent-operations-sdk-0.1.0.tgz
```

```ts
import { AgentOperations } from "@agent-operations/sdk";
```

Requires Node.js 22.12+. The archive contains JavaScript, type declarations, README and Apache-2.0 license. See the [SDK guide](../sdk/typescript/README.md).

## Python SDK

```sh
python -m pip install https://github.com/ArtAndrew/agent-operations/releases/download/v0.1.0/agent_operations_sdk-0.1.0-py3-none-any.whl
```

```python
from agent_operations import AgentOperations
```

Requires Python 3.10+. The client has no runtime dependencies. See the [SDK guide](../sdk/python/README.md). LangGraph and browser-use are optional dependencies of the examples, not of this SDK.

Checksums detect a mismatched download; a checksum hosted beside an asset is not an independent publisher signature. The release links to the workflow and source commit used to create it.
