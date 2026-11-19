# Agent BI extension

| Field    | Value                        |
| -------- | ---------------------------- |
| Project  | Lightdash Agent BI extension |
| Version  | Unreleased                   |
| Created  | 2026-11-11 12:28 -05         |
| Updated  | 2026-11-11 13:56 -05         |
| Author   | Alfonso de la Guarda Reyes   |
| Location | `docs/agent-bi/CONTEXT.md`   |

**Status: proposed, not implemented.** This context names an independently
authored MIT extension, not the existing in-app [AI agent](../ai-agent/CONTEXT.md).
The [parent issue](https://github.com/alfonsodg/lightdash/issues/1) owns the
roadmap; the [architecture](./architecture.md) describes the proposed boundary.

## Language

**Agent BI extension**:
The proposed assistant for semantic business intelligence, with its own
runtime, native UI and a minimal authenticated backend bridge.
_Avoid_: Ask AI, the existing in-app AI agent

**Agent BI bridge**:
The proposed MIT backend seam that identifies the acting person, checks
authorization and brokers the runtime's access to Lightdash operations. It is
a security boundary, not an existing API or an implementation copied from EE.
_Avoid_: privileged proxy, EE bridge

**Agent runtime**:
The independently authored `packages/agent-bi` component proposed to
coordinate the model, tools and conversation. It cannot grant permissions or
replace the bridge's checks.
_Avoid_: backend identity, privileged agent

**Catalog index**:
A derived search aid over project metadata, filtered and reauthorized for the
acting person. It is neither the authoritative catalog nor a grant of access.
_Avoid_: security index, source of permissions

**Project skill**:
Explicit, project-scoped guidance curated by authorized people for the
extension. It is untrusted instruction data, not a permission grant or automatic
per-user memory. It is distinct from a skill of the existing in-app AI agent.
_Avoid_: implicit memory, agent permission

**SQL guardrail**:
The proposed fail-closed controls required before each extension-requested
arbitrary SQL execution, including saved SQL charts, SQL composition sources
and exports or deliveries that execute them. Disabled by default, it requires
explicit enablement, human approval bound to each execution, authorization, a
verified least-privilege read-only warehouse identity, warehouse-enforced
per-user isolation, dialect-aware AST validation of the actual SQL, limits
and auditing. Deny when any control cannot be inspected, verified or
enforced. SQL generated internally by a governed semantic query is not
arbitrary SQL solely because it is SQL.
_Avoid_: SQL parser as security, approval as authorization

**Human approval**:
An explicit confirmation by the acting person for one specific content write
or arbitrary SQL execution. It is bound to the action and context and does
not replace authorization or warehouse enforcement.
_Avoid_: blanket approval, permission grant

**Runtime overrides**:
The live filters, parameter values, date zoom and active tab captured per
request or prompt, as applicable, consistent with the
[AI agent term](../ai-agent/CONTEXT.md#language). They are not inferred from
saved state; referenced resources are reauthorized on every use. Overrides
describe the requested view and never confer access.
_Avoid_: security policy, permission override

**Grounded citation**:
A reference from an answer to the authorized content or query evidence used
for it. A citation aids inspection; it does not guarantee a correct answer or
eliminate hallucinations.
_Avoid_: proof of correctness

**`agent_ext` schema**:
The proposed PostgreSQL namespace for extension-owned records and separate
migrations. It does not own Lightdash roles or enforce warehouse permissions.
_Avoid_: Lightdash core schema, warehouse security boundary

The existing [AI agent memory](../ai-agent-memory/CONTEXT.md) is deprecated;
this proposal does not silently revive its automatic per-user memory.
