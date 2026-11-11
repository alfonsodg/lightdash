# Agent BI extension architecture

| Field    | Value                           |
| -------- | ------------------------------- |
| Project  | Lightdash Agent BI extension    |
| Version  | Unreleased                      |
| Created  | 2026-11-11 12:28 -05            |
| Updated  | 2026-11-11 13:56 -05            |
| Author   | Alfonso de la Guarda Reyes      |
| Location | `docs/agent-bi/architecture.md` |

**Status: proposed, not implemented or deployed.** This is the security and
integration contract for the independently authored extension, not a
description of an available product. See the [decision record](./adr/0001-hybrid-additive-mit-extension.md),
[glossary](./CONTEXT.md) and [parent issue](https://github.com/alfonsodg/lightdash/issues/1)
for the architectural choice, terminology and roadmap.

## Boundaries

The proposed topology is a separate native UI and an MIT `packages/agent-bi`
runtime, connected through a minimal authenticated MIT backend bridge under
the proposed `/api/ext/v1` namespace. The runtime can request tools; the
bridge brokers authorized operations against the existing Lightdash APIs on
the person's behalf. Neither this namespace nor the bridge is available yet.

The bridge must derive the person from verified authentication, not an
identity supplied by the UI or model. Runtime-to-bridge calls must be
authenticated and bound to that person, project and operation; a runtime
claim or a catalog index is not authority. If the runtime is a separate
service, authenticate the service separately from the delegated user: a
service credential does not establish the person's access. Require secure
transport, and protect session-backed operations against CSRF and unauthorized
origins. Recheck authentication, effective resource access and extension
capability policy on every tool call, result read and deferred execution.
Deny missing or unverifiable checks; a queued action cannot retain access
after revocation. These requirements govern the extension, not unrelated
direct uses of existing APIs.

Each request or prompt captures the live context as applicable: filters,
parameters, date zoom and active tab. Do not assume the saved state matches
what the person is viewing; reauthorize referenced resources on every use.

Extension-owned records use the proposed PostgreSQL `agent_ext` schema and
its own migrations. Configuration, model selection, credentials and limits
are external to the code. A catalog index is derived and filtered for the
current user, never an authorization source. Project skills are explicit,
authorized guidance, not implicit user memory; the existing
[AI agent memory](../ai-agent-memory/CONTEXT.md) is deprecated.

Treat model output, retrieved content and skills as untrusted input. They
cannot grant tools or change policy. Never send user or service credentials
to a model or put secrets in prompts or logs. All model providers, including
self-hosted ones, must comply with the data classification and retention
requirements of the content sent to them; minimize and protect prompts,
results and audit data.

## Identity and authorization

Web actions use the real person's session or an actually supported OAuth flow.
A PAT is limited to personal use, never a shared privileged token. Where the
API accepts them, the current authentication middleware distinguishes
`Authorization: ApiKey <personal-token>` from `Authorization: Bearer <oauth-token>`.
Keep credentials out of the model and bind each call to the authenticated
person. Verify OAuth issuer, audience, scopes and grant applicability rather
than assuming that any bearer token is valid.

Built-in project roles are useful expectations, not substitutes for the
effective authorization decision:

- `viewer` can view accessible resources and run permitted saved charts
  upstream, including SQL charts, but cannot run ad hoc explore or metric
  queries merely by being a viewer. The extension adds the SQL guard below.
- `interactive_viewer` is the typical minimum for metric queries and
  underlying data. Extra restrictions can still deny an operation.
- Editing depends on the effective project **and** relevant space permissions;
  an `editor` label alone is not blanket access to every space.
- SQL Runner requires `developer` or `admin` among built-in roles. Custom
  roles and organization-level grants can change the effective result; check
  the actual permission rather than inferring it from a label.

An organization grant is not normally revoked merely by a project custom
role, but conditions, special `cannot` rules and space permissions affect
the result. Always evaluate the effective ability for the resource; see
[ability construction](../../packages/common/src/authorization/index.ts) and
the [project abilities](../../packages/common/src/authorization/projectMemberAbility.ts).
Existing [agent-policy coverage](../agent-identity/agent-permissions.md)
depends on the feature, mode, surface and credential: PAT calls are exempt
from the existing managed agent permissions, and OAuth alone does not turn
them on. The extension must enforce its own policy per call and also honor
any upstream policy that applies.

Upstream, an authorized viewer can run a saved SQL chart without
`manage:SqlRunner`, subject to other access and capability checks. Through
the extension, that execution must pass the same complete guard as any
arbitrary SQL. Denying SQL Runner does not make SQL chart results subject to
semantic row filters.

Configured user attributes can restrict semantic explores, fields and
queries, but filters from every joined model are not necessarily applied
automatically. Verify the compiled explore and actual controls for the user;
refuse when required isolation cannot be demonstrated. User attributes are
not automatically applied as row-level security to arbitrary warehouse SQL.

## Human confirmation and arbitrary SQL

Every agent-initiated content write requires explicit human confirmation.
Bind confirmation to the acting person, project, operation and exact proposed
payload; reject stale or changed proposals and recheck permissions before
the effect. Confirmation is not permission.

Arbitrary SQL is **disabled by default** and requires explicit enablement.
One guard applies to every execution requested by the extension: free-form
SQL, saved SQL charts including dashboard tiles, SQL composition sources,
and exports or deliveries that execute them. The SQL's origin or the API
used cannot bypass this guard. Every execution requires:

1. Explicit human approval bound to that run's exact SQL and parameters,
   person, project and warehouse target. A prior or blanket approval is not
   enough; a changed execution requires new approval.
2. Current authorization for the person, resource and operation, including
   the applicable project, space and extension capability checks.
3. A verified, least-privilege read-only warehouse identity and per-user data
   isolation demonstrably enforced by the warehouse, with no privileged shared
   fallback.
4. Dialect-aware AST validation of the actual SQL to be executed, failing
   closed for unknown or unsafe constructs, multiple statements and
   potentially side-effecting operations.
5. Enforced execution, result and cost limits, plus an audit of the person,
   project, approval, decision and outcome under the retention policy.

Recheck the approval and controls before execution. If the actual SQL, its
identity or any required control cannot be inspected, verified or enforced,
deny execution, including through a scheduler, export or composition path.
AST validation and approval do not replace warehouse permissions or data
isolation.

SQL generated internally by a governed semantic query is not arbitrary SQL
solely because it is SQL; it remains subject to the semantic checks above.
An arbitrary SQL request, saved SQL chart or SQL source is not exempt merely
because a semantic, export or delivery flow wraps it. If its provenance
cannot be established, fail closed. These requirements constrain only the
proposed extension, not upstream Lightdash behavior.

## Scheduled deliveries

Native scheduled deliveries normally run as the schedule owner; manual runs
may use the requesting person's identity. A recipient can therefore receive
results produced with someone else's access. Before an extension-initiated
delivery, verify the execution identity and authorize each recipient or
destination for the actual result. If it executes arbitrary SQL, apply the
same full guard and bind human approval to each run; refuse if the scheduler
cannot enforce them. Do not assume a separate query or row-level security
for each recipient.

## Integration with existing APIs

The source controllers and [generated OpenAPI](../../packages/backend/src/generated/swagger.json)
are the contract authorities. Generated artifacts can lag their source;
verify the target build. The [verified mapping in issue #2](https://github.com/alfonsodg/lightdash/issues/2#issuecomment-6803654932)
records the historical migration without duplicating an API reference here.

The [v2 query controller](../../packages/backend/src/controllers/v2/QueryController.ts)
distinguishes semantic queries, saved charts, dashboard context and
underlying data; these contexts are not interchangeable, and underlying
data requires a previous v2 source query. Execution is asynchronous: poll the
query identifier for status and paginated results, handling failure and expiry.

Authorized discovery can use the [catalog](../../packages/backend/src/controllers/catalogController.ts)
and [explores](../../packages/backend/src/controllers/exploreController.ts).
The legacy catalog table-metadata operation is deprecated and declares **No
replacement**. Explore discovery and query-source schema scans expose only
partial metadata and are not equivalent substitutes.

The core MIT [query-sources controller](../../packages/backend/src/controllers/v2/QuerySourceController.ts)
depends on `compose-sql-runner`, source-specific conditions and permissions;
availability is not universal. Arbitrary SQL through any source, export or
delivery must pass the complete guard above for every execution.

Chart and dashboard content-as-code upserts use project-scoped slugs; see the
[content-as-code controller](../../packages/backend/src/controllers/ProjectCoderController.ts).
Retrieving a chart and its results does not create a chart, and a bulk
metadata edit does not replace a full definition; see the
[saved-chart controller](../../packages/backend/src/controllers/savedChartController.ts)
and [project router](../../packages/backend/src/routers/projectRouter.ts).
All extension-initiated writes require effective project and space permissions
and human confirmation.

In space-as-code, omitting `access` preserves an existing policy; an explicit
`access` block can replace the complete direct policy. The extension must not
change access policies or permissions, or implicitly create public spaces
when generating content. Verify upsert side effects and reject if safety
cannot be established; human confirmation does not replace authorization.
See [spaces and access](../content-as-code.md#spaces-and-access).

Validate field names, filters and other semantic choices against accessible
metadata before running a query. Where available, cite the source, query,
filters, time context and result freshness, and disclose truncation or
uncertainty. Ask when a request or result is ambiguous. Semantic validation
and citations aid inspection but do **not** guarantee correct answers or
eliminate hallucinations.

Multi-explore pipelines can limit source rows before joining them. Inspect
each source's limit and status, warn about actual or possible truncation, and
never present a truncated or unverified join as complete. Some merge paths
refuse capped sources; honor those refusals rather than treating an absence
of errors as proof of completeness. See the [merge context](../merge-queries/CONTEXT.md).

## Runtime dependencies and rendering

The current backend requires PostgreSQL and S3-compatible storage, including
an endpoint, bucket and region; an app plus PostgreSQL alone is insufficient.
PNG exports require the headless-browser service. CSV exports and scheduled
deliveries require an enabled scheduler worker. Providers, warehouse
connections, delivery targets and other integrations depend on deployment
configuration; none is asserted to be deployed here. See
[backend configuration](../../packages/backend/src/config/parseConfig.ts).

The headless [`@lightdash/visualization`](../../packages/visualization/README.md)
engine does not run queries. `renderChart` returns one of `echarts`, `table`,
`bigNumber`, `custom`, `empty` or `unsupported`; the host must render the
appropriate option, model or spec and handle empty and unsupported cases.
Using the MIT source of `@lightdash/sdk` does not establish a CE embed runtime:
the embed flow requires the enterprise JWT issuing path and appropriate
licensing and configuration.

## MCP transport

An extension MCP interface is proposed, not available by implication. Use
stdio for a personal client and Streamable HTTP for a remote client. The
legacy HTTP+SSE transport is deprecated; that does not make SSE itself
unusable within Streamable HTTP. Both transports must use the same
per-operation identity, permission, confirmation and SQL controls.

Before enabling remote OAuth, verify the actual authorization server and
resource metadata, accepted audience and scopes, grants and supported
capabilities for that deployment. Remote MCP must validate each token's
audience for the intended resource and isolate sessions by authenticated
person and project; a session identifier is not proof of identity. An
arbitrary OAuth token is not sufficient, and an enterprise MCP implementation
must not be assumed to work in CE.

## Licensing and on-demand synchronization

The [root license](../../LICENSE) treats the EE directory and third-party
components separately. Preserve the MIT copyright and permission notices
for copies or substantial portions. The current [backend entry point](../../packages/backend/src/index.ts)
imports EE code even when its features are not used. The intended MIT
boundary of the independently authored extension does not make the complete
application, dependencies or artifact MIT-only. Review the actual artifact,
dependency licenses and distribution and deployment terms separately. Do
not modify or copy `packages/backend/src/ee` or bypass license restrictions.
Source availability is not proof of compliance; obtain appropriate legal
review rather than treating this document as legal advice.

The local SSH remotes are `origin` for `alfonsodg/lightdash` and `upstream`
for `lightdash/lightdash`. Synchronize only when the user requests it. First
inspect the working tree, branches and remotes, and preserve all existing
changes, including untracked files:

```sh
git status --short --branch
git remote -v
```

After the request, fetch and review upstream history and differences before
integrating into the intended fork branch:

```sh
git fetch upstream
```

Stop on conflicts or when user changes would be endangered. Do not fetch,
pull or push automatically, discard changes, or delete branches. Never push
directly to `upstream`; publish or promote through a pull request only with
the user's explicit authorization.
