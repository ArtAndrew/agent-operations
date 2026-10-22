# Security boundaries

## Trust model

Workspace administrators are trusted to publish operation definitions, set provider credentials and grant roles. Reviewers see the resolved action before approving it. Model output, provider responses and browser pages are untrusted inputs; model steps cannot directly execute arbitrary tools or code.

The API scopes resources to the authenticated workspace. API keys are stored as SHA-256 hashes. Secret connector headers use AES-256-GCM encryption with a platform master key. Browser sessions use signed HTTP-only cookies; configure an HTTPS `PUBLIC_ORIGIN` for secure cookies behind a TLS proxy.

The dashboard and API expose operation inputs, outputs, resolved payloads and artifacts to workspace readers. Do not put credentials in those fields. Use connector secret headers for provider authentication. Browser screenshots and page text may contain personal or confidential data; disable screenshots or restrict workspace access as appropriate.

## Outbound access and browser workers

The application requires exact allowed provider origins. HTTP requests resolve and validate destination addresses, pin the selected address, reject redirects and enforce a response-size limit. Private, loopback, link-local and reserved addresses are blocked unless explicit development access is enabled.

Browser contexts are isolated per step, restrict normal requests to the connector origin, disable service workers, WebSockets and downloads, and block mutating requests during read-only execution and verification.

These application controls are not a complete hostile-browser security boundary. Browser vulnerabilities, protocol behavior, redirects, DNS behavior and unexpected browser features require independent containment. Run browser workers as unprivileged processes in isolated infrastructure with enforced egress rules, no cloud metadata access, no host filesystem mounts beyond the artifact directory and no unrelated service credentials. Do not treat a Chromium context as a container or VM.

`ALLOW_PRIVATE_NETWORK=true` is intended for explicit development or separately isolated environments. It disables the private-address restriction and permits HTTP. The local demo enables it only for its loopback supplier origin.

## Decisions, cancellation and uncertainty

An approval covers an immutable resolved action payload. It is not an assertion that the external provider is honest or that a selector still represents the intended business action. Review connector permissions and verification contracts.

Two-person policy separates API-key identities. Administrators can create additional keys and modify workspace policy; stronger organizational separation requires an external identity and access-management layer.

Cancellation cannot roll back a completed external effect. The engine keeps unresolved mutations visible and requires reconciliation or evidence-based resolution.

## Deployment responsibilities

Provide TLS, private database access, encrypted backups, a secret-management mechanism, an egress firewall, resource limits and operational monitoring. Do not expose local demo login remotely. Preserve and back up the master key separately from database data.

The event hash chain provides a consistency check over retained records; it is not independently anchored and is not a compliance certification. Administrators with database access can rewrite the chain.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting feature if available. Avoid posting active credentials, customer data or a working exploit against a live installation in public issues. Include affected versions and a minimal reproduction using a local test provider.
