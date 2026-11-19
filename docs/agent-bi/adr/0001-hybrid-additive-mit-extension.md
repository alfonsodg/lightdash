# Hybrid additive MIT extension

| Field    | Value                                                     |
| -------- | --------------------------------------------------------- |
| Project  | Lightdash Agent BI extension                              |
| Version  | Unreleased                                                |
| Created  | 2026-11-11 12:28 -05                                      |
| Updated  | 2026-11-11 13:57 -05                                      |
| Author   | Alfonso de la Guarda Reyes                                |
| Location | `docs/agent-bi/adr/0001-hybrid-additive-mit-extension.md` |

**Status: decision approved; implementation not started.** The decisions
are architecture option C and identity option B. The
[parent issue](https://github.com/alfonsodg/lightdash/issues/1) owns the
roadmap; this record does not claim that any extension is deployed.

## Context

The extension needs native interaction and semantic queries without taking a
shared privileged identity, making a broad upstream fork, or depending on
enterprise-only agent functionality. The existing application's source or
features alone do not establish licensing compliance for a distribution or
production deployment.

## Decision

**Option C: hybrid additive architecture.** Independently author the MIT
`packages/agent-bi` runtime, a separate native UI and a minimal authenticated
MIT backend bridge, with `/api/ext/v1` as the proposed namespace. Keep
extension-owned PostgreSQL data in `agent_ext` with separate migrations and
externalize configuration. These are design boundaries, not available APIs.
Do not modify or copy `packages/backend/src/ee`, bypass license enforcement,
or treat enterprise-only features as available merely because their source is
present.

**Option B: delegated identity and isolated SQL.** Web actions act for the
real person through a session or supported OAuth flow; a personal access token
(PAT) is for personal use only. The bridge must authenticate and recheck the
person's effective project and space permissions and the extension's
capability policy on every operation. Apply upstream policy where it actually
applies; do not assume OAuth enables it or that a PAT is covered. No shared
privileged token or secret is given to the model.

Arbitrary SQL is disabled by default and requires explicit enablement. Every
extension-requested execution, including saved SQL charts, SQL composition
sources and exports or deliveries that execute them, requires human approval
bound to that run's SQL, parameters, person, project and warehouse target;
current authorization; a verified least-privilege read-only warehouse
identity; warehouse-enforced per-user isolation; dialect-aware AST validation
of the actual SQL; limits; and auditing. Deny if the SQL or any control
cannot be inspected, verified or enforced. SQL generated internally by a
governed semantic query is not arbitrary SQL solely because it is SQL.
Agent-initiated content writes also require human confirmation. Approval and
parsing never replace authorization or warehouse enforcement. The full
contract is in the [architecture](../architecture.md).

## Alternatives and trade-offs

- **External gateway only:** isolates deployment and reduces core changes, but
  leaves native UI and reliable user-bound authorization as integration
  problems at every call. It does not provide the chosen backend seam.
- **Broad fork or port of enterprise agent functionality:** could offer tighter
  integration, but increases upstream conflicts and introduces licensing and
  maintenance risk. Copying or modifying the EE implementation is excluded.
- **Shared privileged service identity:** simplifies automation but can widen
  access beyond the person asking. Delegation and independent checks are
  required instead.
- **Approval or SQL parsing alone:** can reduce mistakes but cannot prove
  read-only access or isolate data in the warehouse; neither is sufficient.

## Consequences

The narrow seam reduces the upstream change surface but must itself be
maintained, secured and checked for compatibility. The runtime must enforce
its own capability restrictions even on surfaces where upstream agent-policy
enforcement is absent. Some deployments or identity flows may not support the
required guarantees and must fail closed rather than fall back to broader
access.

The root [license](../../../LICENSE) reserves separate terms for the EE
directory and original licenses for third-party components. MIT copies or
substantial portions require the copyright and permission notices; review the
licenses of included dependencies and distribution obligations separately.
The current [backend entry point](../../../packages/backend/src/index.ts)
imports EE code even if its features are unused. The extension's MIT boundary
does not make the combined application or artifact MIT-only; assess the
actual distribution and deployment. This is not a definitive legal opinion.
