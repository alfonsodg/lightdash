import type { z } from 'zod';
import type { AgentPrincipal } from '../auth/agentPrincipal';
import {
    CONTENT_CAPABILITY,
    CONTENT_TOOL_NAMES,
    createContentTools,
    getChartOrDashboardInputSchema,
    upsertChartAsCodeInputSchema,
    upsertDashboardAsCodeInputSchema,
    upsertSqlChartAsCodeInputSchema,
    validateChartConfigInputSchema,
    type ContentToolDeps,
    type ContentToolName,
} from '../content/contentTools';
import {
    createExportTools,
    EXPORT_CAPABILITY,
    EXPORT_TOOL_NAMES,
    exportChartImageInputSchema,
    exportDashboardCsvInputSchema,
    exportDashboardImageInputSchema,
    scheduleChartDeliveryInputSchema,
    scheduleDashboardDeliveryInputSchema,
    type ExportToolDeps,
    type ExportToolName,
} from '../export/exportTools';
// Shared catalogue of the Phase 3-4 tools: single source for MCP
// registration and the runtime orchestrator. Execution delegates to the
// owning module, so policy gating, guards and audit rows stay identical.
import { AgentToolError } from './agentToolTypes';
import type { AgentToolRuntimeOptions } from './agentToolTypes';
import {
    createDiscoveryTools,
    DISCOVER_CAPABILITY,
    DISCOVERY_TOOL_NAMES,
    getExploreInputSchema,
    getMetricMetadataInputSchema,
    inspectWarehouseColumnsInputSchema,
    listExploresInputSchema,
    listSpacesAndContentInputSchema,
    searchCatalogFieldsInputSchema,
    searchFieldValuesInputSchema,
    type DiscoveryToolDeps,
    type DiscoveryToolName,
} from './discoveryTools';
import {
    createQueryTools,
    QUERY_TOOL_NAMES,
    runComposePipelineInputSchema,
    runMetricQueryInputSchema,
    runSavedChartInputSchema,
    runSqlInputSchema,
    runUnderlyingDataInputSchema,
    TOOL_CAPABILITIES,
    type QueryToolDeps,
    type QueryToolName,
} from './queryTools';

export type ToolCatalogAllDeps = DiscoveryToolDeps &
    QueryToolDeps &
    ContentToolDeps &
    ExportToolDeps;

export interface ToolCatalogEntry {
    capability: string;
    description: string;
    inputSchema: z.ZodObject<z.ZodRawShape>;
    name: string;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
    {
        capability: DISCOVER_CAPABILITY,
        description:
            'Describe one explore: dimensions, metrics and joinable tables.',
        inputSchema: getExploreInputSchema,
        name: 'get_explore',
    },
    {
        capability: DISCOVER_CAPABILITY,
        description: 'Show metadata for one metric.',
        inputSchema: getMetricMetadataInputSchema,
        name: 'get_metric_metadata',
    },
    {
        capability: DISCOVER_CAPABILITY,
        description: 'Inspect warehouse columns backing an explore.',
        inputSchema: inspectWarehouseColumnsInputSchema,
        name: 'inspect_warehouse_columns',
    },
    {
        capability: DISCOVER_CAPABILITY,
        description: 'List explores available in a project.',
        inputSchema: listExploresInputSchema,
        name: 'list_explores',
    },
    {
        capability: DISCOVER_CAPABILITY,
        description: 'List spaces with their charts and dashboards.',
        inputSchema: listSpacesAndContentInputSchema,
        name: 'list_spaces_and_content',
    },
    {
        capability: DISCOVER_CAPABILITY,
        description: 'Search catalog fields by name across explores.',
        inputSchema: searchCatalogFieldsInputSchema,
        name: 'search_catalog_fields',
    },
    {
        capability: DISCOVER_CAPABILITY,
        description: 'Search distinct values of a field.',
        inputSchema: searchFieldValuesInputSchema,
        name: 'search_field_values',
    },
    {
        capability: TOOL_CAPABILITIES.run_compose_pipeline,
        description: 'Run a multi-query compose pipeline.',
        inputSchema: runComposePipelineInputSchema,
        name: 'run_compose_pipeline',
    },
    {
        capability: TOOL_CAPABILITIES.run_metric_query,
        description: 'Run a governed metric query and poll it ready.',
        inputSchema: runMetricQueryInputSchema,
        name: 'run_metric_query',
    },
    {
        capability: TOOL_CAPABILITIES.run_saved_chart,
        description: 'Run a saved chart query and poll it ready.',
        inputSchema: runSavedChartInputSchema,
        name: 'run_saved_chart',
    },
    {
        capability: TOOL_CAPABILITIES.run_sql,
        description: 'Run read-only SQL under the guard when enabled.',
        inputSchema: runSqlInputSchema,
        name: 'run_sql',
    },
    {
        capability: TOOL_CAPABILITIES.run_underlying_data,
        description: 'Fetch underlying rows for a chart query.',
        inputSchema: runUnderlyingDataInputSchema,
        name: 'run_underlying_data',
    },
    {
        capability: CONTENT_CAPABILITY,
        description: 'Fetch a chart or dashboard definition.',
        inputSchema: getChartOrDashboardInputSchema,
        name: 'get_chart_or_dashboard',
    },
    {
        capability: CONTENT_CAPABILITY,
        description: 'Create or update a chart from a definition.',
        inputSchema: upsertChartAsCodeInputSchema,
        name: 'upsert_chart_as_code',
    },
    {
        capability: CONTENT_CAPABILITY,
        description: 'Create or update a dashboard from a definition.',
        inputSchema: upsertDashboardAsCodeInputSchema,
        name: 'upsert_dashboard_as_code',
    },
    {
        capability: CONTENT_CAPABILITY,
        description: 'Create or update a SQL chart; needs approval.',
        inputSchema: upsertSqlChartAsCodeInputSchema,
        name: 'upsert_sql_chart_as_code',
    },
    {
        capability: CONTENT_CAPABILITY,
        description: 'Validate a chart config without saving.',
        inputSchema: validateChartConfigInputSchema,
        name: 'validate_chart_config',
    },
    {
        capability: EXPORT_CAPABILITY,
        description: 'Export a chart as an image.',
        inputSchema: exportChartImageInputSchema,
        name: 'export_chart_image',
    },
    {
        capability: EXPORT_CAPABILITY,
        description: 'Export a dashboard as CSV.',
        inputSchema: exportDashboardCsvInputSchema,
        name: 'export_dashboard_csv',
    },
    {
        capability: EXPORT_CAPABILITY,
        description: 'Export a dashboard as an image.',
        inputSchema: exportDashboardImageInputSchema,
        name: 'export_dashboard_image',
    },
    {
        capability: EXPORT_CAPABILITY,
        description: 'Schedule recurring chart delivery.',
        inputSchema: scheduleChartDeliveryInputSchema,
        name: 'schedule_chart_delivery',
    },
    {
        capability: EXPORT_CAPABILITY,
        description: 'Schedule recurring dashboard delivery.',
        inputSchema: scheduleDashboardDeliveryInputSchema,
        name: 'schedule_dashboard_delivery',
    },
];

export const createToolCatalog = (deps: ToolCatalogAllDeps) => {
    const discovery = createDiscoveryTools(deps);
    const query = createQueryTools(deps);
    const content = createContentTools(deps);
    const exportTools = createExportTools(deps);

    const execute = async (
        toolName: string,
        rawInput: unknown,
        principal: AgentPrincipal,
        options: AgentToolRuntimeOptions = {},
    ): Promise<unknown> => {
        if ((DISCOVERY_TOOL_NAMES as readonly string[]).includes(toolName)) {
            return discovery.executeTool(
                toolName as DiscoveryToolName,
                rawInput,
                principal,
                options,
            );
        }
        if ((QUERY_TOOL_NAMES as readonly string[]).includes(toolName)) {
            return query.executeTool(
                toolName as QueryToolName,
                rawInput,
                principal,
                options,
            );
        }
        if ((CONTENT_TOOL_NAMES as readonly string[]).includes(toolName)) {
            return content.executeTool(
                toolName as ContentToolName,
                rawInput,
                principal,
                options,
            );
        }
        if ((EXPORT_TOOL_NAMES as readonly string[]).includes(toolName)) {
            return exportTools.executeTool(
                toolName as ExportToolName,
                rawInput,
                principal,
                options,
            );
        }
        throw new AgentToolError(
            'UNKNOWN_TOOL',
            `Unknown tool "${toolName}".`,
            'UNKNOWN_TOOL',
        );
    };

    return { entries: TOOL_CATALOG, execute };
};

export type ToolCatalog = ReturnType<typeof createToolCatalog>;
