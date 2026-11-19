import { FilterOperator, type Dashboard } from '@lightdash/common';
import { renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createDashboardTestStore } from '../../../testing/dashboardStore';
import { DashboardStoreTestProvider } from '../../../testing/DashboardStoreTestProvider';
import { useAgentBiDashboardContext } from './useAgentBiDashboardContext';

describe('useAgentBiDashboardContext', () => {
    it('captures filter values and parameters from the active dashboard', () => {
        const store = createDashboardTestStore({
            dashboardFilters: {
                dimensions: [
                    {
                        id: 'region',
                        label: undefined,
                        operator: FilterOperator.EQUALS,
                        target: {
                            fieldId: 'orders_region',
                            tableName: 'orders',
                        },
                        values: ['EU'],
                    },
                ],
                metrics: [],
                tableCalculations: [],
            },
            parameterValues: { currency: 'EUR' },
            source: { queryDashboard: { slug: 'revenue' } as Dashboard },
        });
        const { result } = renderHook(() => useAgentBiDashboardContext(), {
            wrapper: ({ children }: { children: ReactNode }) => (
                <DashboardStoreTestProvider store={store}>
                    {children}
                </DashboardStoreTestProvider>
            ),
        });

        expect(result.current).toMatchObject({
            dashboardFilters: {
                dimensions: [
                    {
                        operator: FilterOperator.EQUALS,
                        target: { fieldId: 'orders_region' },
                        values: ['EU'],
                    },
                ],
                metrics: [],
                tableCalculations: [],
            },
            dashboardSlug: 'revenue',
            parameters: { currency: 'EUR' },
        });
    });
});
