// Reads live dashboard state (filters, tab, date zoom, parameters)
// for the contextual drawer. Outside a dashboard provider the
// selectors return empty values and the context is null.
import { selectActiveTab } from '../../../features/dashboard/store/dashboardEditSelectors';
import {
    useDashboardAllFilters,
    useDashboardSelector,
} from '../../../features/dashboard/store/hooks';
import { selectDateZoomGranularity } from '../../../features/dashboard/store/selectors';
import type { AgentBiDrawerContext } from '../components/AgentBiContextualDrawer';

export const useAgentBiDashboardContext = (): AgentBiDrawerContext | null => {
    const activeTab = useDashboardSelector(selectActiveTab);
    const dateZoom = useDashboardSelector(selectDateZoomGranularity);
    const filters = useDashboardAllFilters();
    const activeFilters = [...filters.dimensions, ...filters.metrics];
    if (
        activeTab === undefined &&
        dateZoom === undefined &&
        activeFilters.length === 0
    ) {
        return null;
    }
    return {
        activeTab: activeTab?.name,
        dashboardFilters: activeFilters.map((filter) => ({
            fieldId: filter.target.fieldId,
            value: filter.operator,
        })),
        dateZoom: dateZoom === undefined ? undefined : String(dateZoom),
    };
};
