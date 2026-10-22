# Contributing

Use Node.js 22.12+ and the pnpm version recorded in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium --only-shell
pnpm typecheck
pnpm test
pnpm build
pnpm test:browser
pnpm test:e2e
```

Keep public code, UI labels, examples and documentation in English. Never commit credentials, local database files, customer data or generated execution artifacts.

Add tests for changed execution guarantees, authorization boundaries and failure behavior. For writes, cover uncertainty and recovery, not only successful responses. Test database coordination against network PostgreSQL using `TEST_DATABASE_URL`; embedded PostgreSQL alone cannot exercise independent PostgreSQL sessions.

The core source is under ELv2. SDK directories have their own Apache-2.0 licenses. Do not copy third-party implementation code into the core without preserving its license and attribution. Contributions must have a clear license compatible with the destination; do not assume a pull request grants additional commercial relicensing rights.

Keep documentation tied to observable behavior. Do not claim universal exactly-once delivery, billing accuracy, regulatory compliance or production capacity without appropriate evidence.
