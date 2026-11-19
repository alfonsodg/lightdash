# AI Agent Extension for Lightdash CE

> Proposal for running an AI agent on top of the open-source (MIT) Lightdash core
> without copying, redistributing, or bypassing the Source Available
> `packages/backend/src/ee/` code. This document is a local design note, not
> upstream documentation.

## 1. Goal

Let an AI agent (Claude Code, Cursor, ChatGPT, a custom chat UI, or a
self-hosted model behind an OpenAI-compatible endpoint) answer business
questions, run governed metric queries, create charts and dashboards, and
export results — using only the public REST API of Lightdash Community
Edition.

## 2. Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  Chat UI  │  Claude Code  │  Cursor  │  Any MCP client      │
└─────┬─────────────┬────────────┬──────────────┬─────────────┘
      │             │            │              │
      └─────────────┴───── MCP ──┴──────────────┘
                          │
                 ┌────────▼────────┐
                 │  Agent Gateway  │  (new service: Python or TypeScript)
                 │  - tool layer   │
                 │  - prompt       │
                 │  - guardrails   │
                 │  - memory       │
                 └────────┬────────┘
                          │  Lightdash REST API (PAT / API key)
                 ┌────────▼────────┐
                 │  Lightdash CE   │  (MIT core)
                 └────────┬────────┘
                          │
                 ┌────────▼────────┐
                 │  ClickHouse /   │
                 │  warehouse      │
                 └─────────────────┘
```

The agent gateway is an **external service**. No changes to the Lightdash core
are required. Optionally, fork the MIT core only for UI integration.

## 3. Licensing boundary

- The MIT core (everything outside `packages/backend/src/ee/`) may be forked,
  modified, and self-hosted freely.
- `packages/backend/src/ee/LICENSE` is the **Lightdash Source Available
  License**:
  - production use requires a valid Lightdash Enterprise Subscription;
  - copying and modifying is allowed for development and testing only;
  - copying, merging, publishing, distributing, sublicensing, or selling the
    EE software is forbidden;
  - modifications and patches may only be used with a valid Enterprise
    Subscription;
  - the license terminates on breach.
- Do **not** copy the EE `AiAgentService`, `McpService`, chart registry, data
  apps, or license-check code into this extension.
- Do **not** bypass `getEnterpriseAppArguments()` or license validation.

This extension is therefore an **independent layer over the CE API**, not a
fork of the EE.

## 4. Components to build

### 4.1 Credentials and permissions

- Create a dedicated Lightdash user with the minimum role:
  - `viewer` for query-only agents;
  - `editor` only when the agent must create charts/dashboards.
- Generate a Personal Access Token / API key. The CE routes accept API key
  authentication (`allowApiKeyAuthentication`).
- Apply row-level security through Lightdash user attributes; never use an
  admin token for the agent.
- Store secrets in the gateway's environment or secret manager.

### 4.2 Catalog / context indexer

Sync the semantic layer into a local index (Postgres, SQLite, or an embedding
store). This is what prevents hallucinated SQL.

| Purpose | Lightdash endpoint |
|---|---|
| List explores | `GET /api/v1/projects/{projectUuid}/explores` |
| Explore fields (dimensions, metrics, descriptions, types) | `GET /api/v1/projects/{projectUuid}/explores/{exploreId}` |
| Data catalog | `GET /api/v1/projects/{projectUuid}/dataCatalog` |
| Metrics catalog | `GET /api/v1/projects/{projectUuid}/dataCatalog/metrics` |
| Table metadata | `GET /api/v1/projects/{projectUuid}/dataCatalog/{table}/metadata` |
| Field unique values | `POST /api/v1/projects/{projectUuid}/field/{fieldId}/search` |

Store: explore name, label, description; field name, label, type,
description, table, and available values. Optionally embed descriptions for
semantic search.

### 4.3 Tool layer (API wrapper)

Implement these tools in the gateway. Each tool validates input, calls the
Lightdash API, and returns a structured result plus an audit record.

**Discovery**

- `list_explores()` → `GET .../explores`
- `get_explore(exploreId)` → `GET .../explores/{exploreId}`
- `search_fields(query)` → local index
- `get_field_values(fieldId, search)` → `POST .../field/{fieldId}/search`
- `get_metric_metadata(table, metric)` → `GET .../dataCatalog/metrics/{tableName}/{metricName}`

**Query**

- `run_metric_query(exploreId, metricQuery)` →
  `POST /api/v1/projects/{projectUuid}/explores/{exploreId}/runQuery`
- `run_underlying_data(exploreId, query)` →
  `POST /api/v1/projects/{projectUuid}/explores/{exploreId}/runUnderlyingDataQuery`
- `run_sql(sql)` → `POST /api/v1/projects/{projectUuid}/sqlRunner/run`
  (read-only validation; see guardrails)
- `list_warehouse_tables()` → `GET /api/v1/projects/{projectUuid}/sqlRunner/tables`
- `describe_warehouse_table()` → `GET /api/v1/projects/{projectUuid}/sqlRunner/fields`

**Content creation**

- `create_chart(projectUuid, payload)` →
  `POST /api/v1/projects/{projectUuid}/saved`
- `create_chart_and_run(payload)` →
  `POST /api/v1/saved/{chartUuid}/chart-and-results`
- `update_charts(payload)` →
  `PATCH /api/v1/projects/{projectUuid}/saved`
- `run_saved_chart(chartUuid)` →
  `POST /api/v1/saved/{chartUuid}/results`
- `create_dashboard(projectUuid, payload)` →
  `POST /api/v1/projects/{projectUuid}/dashboards`
- `update_dashboard(dashboardUuid, payload)` →
  `PATCH /api/v1/dashboards/{dashboardUuidOrSlug}`
- `get_dashboard(dashboardUuid)` →
  `GET /api/v1/dashboards/{dashboardUuidOrSlug}`

**Export and delivery**

- `export_chart_image(chartUuid)` →
  `POST /api/v1/saved/{chartUuid}/export`
- `export_dashboard_image(dashboardUuid)` →
  `POST /api/v1/dashboards/{dashboardUuid}/export`
- `export_dashboard_csv(dashboardUuid)` →
  `POST /api/v1/dashboards/{dashboardUuid}/exportCsv`
- `schedule_chart(chartUuid, payload)` →
  `POST /api/v1/saved/{chartUuid}/schedulers`
- `schedule_dashboard(dashboardUuid, payload)` →
  `POST /api/v1/dashboards/{dashboardUuid}/schedulers`

**Search**

- `find_content(query)` → `GET /api/v1/projects/{projectUuid}/search/{query}`

### 4.4 MCP server

Wrap the tool layer in an MCP server so any MCP-capable agent can use it.

- SDK: `@modelcontextprotocol/sdk` (TypeScript) or `mcp` (Python).
- Transports:
  - `stdio` for Claude Code / Cursor;
  - HTTP/SSE for remote agents.
- Authentication: PAT from environment; optional OAuth for multi-user.
- Tool schemas: stable names and JSON Schema, versioned.
- Output: structured JSON, with a compact human-readable summary.
- Every call writes an audit record.

### 4.5 Agent runtime (optional custom chat)

If a standalone chat experience is needed:

- LLM: OpenAI-compatible endpoint (`base_url` pointing at Ollama, vLLM,
  LiteLLM, LocalAI) or Anthropic/OpenAI.
- System prompt: inject the semantic layer (explores, metrics, dimensions,
  descriptions), business rules, and the tool contract.
- Loop: discovery → `run_metric_query` or `run_sql` → `create_chart` →
  `export` or `create_dashboard`.
- Memory: separate `agent_threads` / `agent_messages` tables; do not modify
  the Lightdash schema.
- Evaluation: golden questions plus expected query/result checks.

### 4.6 UI (optional)

- Chat UI in React/Next.js.
- To render charts without the EE, use the MIT `@lightdash/visualization`
  package, which exposes headless `renderChart()` with ECharts/Vega models.
- Alternatively, link users to the chart or dashboard created in Lightdash CE.

### 4.7 Observability and audit

- Log: user, tool name, input, Lightdash endpoint, status, row count, latency.
- Metrics: queries per user, error rate, token usage, cost.
- Alerts: repeated failures, permission denied, SQL rejected by guardrails.

## 5. Guardrails

- **Read-only SQL**: reject DDL/DML (`INSERT`, `UPDATE`, `DELETE`, `DROP`,
  `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`).
- **Row limits**: enforce a maximum row count and query timeout.
- **SQL approval gate**: for `run_sql` and content creation, require human
  approval before execution or publication.
- **Permission enforcement**: rely on Lightdash roles and user attributes;
  never cache results across users without permission checks.
- **Prompt-injection defense**: treat warehouse data and field descriptions as
  untrusted input; never let them change tool permissions.
- **Rate limiting** per user and per tool.
- **No secret exfiltration**: the agent never sees database credentials;
  only the Lightdash API token.

## 6. Minimum viable agent (MVP)

1. `list_explores`
2. `get_explore`
3. `run_metric_query`
4. `create_chart`
5. `export_chart_image`
6. MCP server over stdio
7. System prompt with semantic layer context

This already covers: natural-language question → governed query → chart →
export. Add `run_sql` with approval, dashboards, scheduled deliveries, and
memory afterwards.

## 7. Deployment

`docker-compose` services:

- `lightdash` (CE) + `postgres`;
- `agent-gateway` (tool layer + MCP server);
- optional `ollama` or `vllm` for self-hosted models;
- optional `chat-ui`.

Environment variables for the gateway:

```env
LIGHTDASH_URL=https://lightdash.example.com
LIGHTDASH_API_KEY=<personal-access-token>
LIGHTDASH_PROJECT_UUID=<project-uuid>
LLM_BASE_URL=http://ollama:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen3.5:9b
AGENT_MAX_ROWS=5000
AGENT_QUERY_TIMEOUT_SECONDS=60
```

## 8. What not to do

- Do not copy `packages/backend/src/ee/` or its AI/MCP implementation.
- Do not redistribute EE patches without an Enterprise Subscription.
- Do not remove or bypass license validation.
- Do not use EE features in production without a subscription.

## 9. Future work

- Add embeddings over the catalog for semantic field search.
- Add a query-result cache keyed by user, explore, and metric query.
- Add chart-type recommendations based on the result shape.
- Add evaluation harness with golden SQL and expected results.
- Add multi-tenant mapping between gateway users and Lightdash users.
- Add support for external MCP servers (e.g., a knowledge base) alongside the
  Lightdash tools.
