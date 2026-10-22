#!/usr/bin/env bash
set -euo pipefail
image="${1:?Supply an image tag}"
container="aop-smoke-${RANDOM}-${RANDOM}"
response="$(mktemp)"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -f "$response"; }
trap cleanup EXIT
AOP_SMOKE_TOKEN=$(openssl rand -hex 32)
AOP_SMOKE_MASTER=$(openssl rand -hex 32)
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  echo "::add-mask::$AOP_SMOKE_TOKEN"
  echo "::add-mask::$AOP_SMOKE_MASTER"
fi
docker run -d --name "$container" -p 127.0.0.1::4300 \
  -e ADMIN_TOKEN="$AOP_SMOKE_TOKEN" -e MASTER_KEY="$AOP_SMOKE_MASTER" "$image" >/dev/null
address="$(docker port "$container" 4300/tcp)"
for attempt in $(seq 1 60); do
  if curl --fail --silent "http://$address/readyz" >/dev/null; then break; fi
  sleep 1
done
if ! curl --fail --silent "http://$address/readyz"; then
  docker logs "$container"
  exit 1
fi
curl --fail --silent --output "$response" -X POST "http://$address/api/v1/workspaces" \
  -H "Authorization: Bearer $AOP_SMOKE_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Container smoke test"}'
node -e 'const fs=require("node:fs");if(!JSON.parse(fs.readFileSync(process.argv[1])).token)process.exit(1)' "$response"
docker exec "$container" node --input-type=module -e 'import {chromium} from "playwright";const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.setContent("<h1>Browser ready</h1>");if(await page.locator("h1").innerText()!=="Browser ready")throw new Error("Browser check failed");}finally{await browser.close();}'
echo "API workspace creation and real Chromium launch passed."
