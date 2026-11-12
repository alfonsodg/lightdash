import { selectActiveTab } from '../../../features/dashboard/store/dashboardEditSelectors';
import { selectDashboard } from '../../../features/dashboard/store/dashboardSourceSelectors';
import {
    useDashboardAllFilters,
    useDashboardSelector,
} from '../../../features/dashboard/store/hooks';
import {
    selectDateZoomGranularity,
    selectParameterValues,
} from '../../../features/dashboard/store/selectors';
import type { AgentBiDrawerContext } from '../components/AgentBiContextualDrawer';

export const useAgentBiDashboardContext = (): AgentBiDrawerContext | null => {
    const activeTab = useDashboardSelector(selectActiveTab);
    const dashboard = useDashboardSelector(selectDashboard);
    const dateZoom = useDashboardSelector(selectDateZoomGranularity);
    const parameters = useDashboardSelector(selectParameterValues);
    const filters = useDashboardAllFilters();
    const activeFilters = [
        ...filters.dimensions,
        ...filters.metrics,
        ...filters.tableCalculations,
    ];
    if (
        activeTab === undefined &&
        dashboard?.slug === undefined &&
        dateZoom === undefined &&
        activeFilters.length === 0 &&
        Object.keys(parameters).length === 0
    ) {
        return null;
    }
    return {
        activeTab: activeTab?.name,
        dashboardFilters: filters,
        dashboardSlug: dashboard?.slug,
        dateZoom: dateZoom === undefined ? undefined : String(dateZoom),
        parameters,
    };
};
