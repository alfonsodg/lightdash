import { FilterOperator } from '@lightdash/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import MantineBaseProvider from '../../../providers/MantineBaseProvider';
import { decideApproval } from '../api';
import { streamThreadTurn } from '../hooks/useAgentBiStream';
import AgentBiWorkspacePage from './AgentBiWorkspacePage';

vi.mock('../hooks/useAgentBiThreads', () => ({
    useAgentBiThreads: () => ({
        create: vi.fn(),
        data: [{ threadUuid: 'thread-1', title: 'Thread' }],
        error: null,
        isLoading: false,
    }),
}));

vi.mock('../hooks/useAgentBiMessages', () => ({
    useAgentBiMessages: () => ({ data: [] }),
}));

vi.mock('../components/ProjectSkillsModal', () => ({
    default: () => null,
}));

vi.mock('../components/AgentBiChartRenderer', () => ({
    default: ({ output }: { output: { kind: string } }) => (
        <div data-testid={`chart-kind-${output.kind}`} />
    ),
}));

vi.mock('../api', () => ({ decideApproval: vi.fn(async () => {}) }));

vi.mock('../hooks/useAgentBiStream', () => ({
    streamThreadTurn: vi.fn(async () => {}),
}));

describe('AgentBiWorkspacePage', () => {
    it('opens without a dashboard store', () => {
        render(
            <MantineBaseProvider env="test">
                <MemoryRouter>
                    <AgentBiWorkspacePage />
                </MemoryRouter>
            </MantineBaseProvider>,
        );

        expect(screen.getByLabelText('Ask a question')).toBeInTheDocument();
    });

    it('sends the current dashboard context with a question', async () => {
        const filters = {
            dimensions: [
                {
                    id: 'region',
                    label: undefined,
                    operator: FilterOperator.EQUALS,
                    target: { fieldId: 'orders_region', tableName: 'orders' },
                    values: ['EU'],
                },
            ],
            metrics: [],
            tableCalculations: [],
        };
        render(
            <MantineBaseProvider env="test">
                <MemoryRouter>
                    <AgentBiWorkspacePage
                        dashboardContext={{
                            activeTab: 'Overview',
                            dashboardFilters: filters,
                            dashboardSlug: 'revenue',
                            dateZoom: 'month',
                            parameters: { currency: 'EUR' },
                        }}
                    />
                </MemoryRouter>
            </MantineBaseProvider>,
        );
        fireEvent.change(screen.getByLabelText('Ask a question'), {
            target: { value: 'What changed?' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() =>
            expect(streamThreadTurn).toHaveBeenCalledWith(
                expect.objectContaining({
                    pinnedContext: { kind: 'dashboard', slug: 'revenue' },
                    runtimeOverrides: {
                        activeTab: 'Overview',
                        dateZoom: 'month',
                        filters,
                        parameters: { currency: 'EUR' },
                    },
                    userText: 'What changed?',
                }),
                expect.any(Function),
            ),
        );
    });

    it('renders query artifacts delivered by the stream', async () => {
        vi.mocked(streamThreadTurn).mockReset();
        vi.mocked(streamThreadTurn).mockImplementationOnce(
            async (_input, onEvent) => {
                onEvent({
                    type: 'chart_artifact',
                    data: {
                        kind: 'query',
                        preview: {
                            columns: {
                                orders_count: {
                                    format: null,
                                    label: 'Orders',
                                    type: 'number',
                                },
                                orders_status: {
                                    format: null,
                                    label: 'Status',
                                    type: 'string',
                                },
                            },
                            dimensions: ['orders_status'],
                            metrics: ['orders_count'],
                            rows: [
                                {
                                    orders_count: 3,
                                    orders_status: 'complete',
                                },
                            ],
                        },
                        tool: 'run_metric_query',
                        uuid: 'query-1',
                    },
                });
            },
        );
        render(
            <MantineBaseProvider env="test">
                <MemoryRouter>
                    <AgentBiWorkspacePage />
                </MemoryRouter>
            </MantineBaseProvider>,
        );
        fireEvent.change(screen.getByLabelText('Ask a question'), {
            target: { value: 'Count orders by status.' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        expect(
            await screen.findByTestId('chart-kind-echarts'),
        ).toBeInTheDocument();
    });

    it('resumes an approved action with its original context', async () => {
        vi.mocked(streamThreadTurn).mockReset();
        vi.mocked(streamThreadTurn).mockImplementationOnce(
            async (_input, onEvent) => {
                onEvent({
                    type: 'approval_required',
                    data: {
                        approvalUuid: 'approval-1',
                        input: { sql: 'select 1' },
                        tool: 'run_sql',
                    },
                });
            },
        );
        const view = (dashboardSlug: string) => (
            <MantineBaseProvider env="test">
                <MemoryRouter>
                    <AgentBiWorkspacePage
                        dashboardContext={{
                            dashboardSlug,
                            activeTab: 'Overview',
                            dateZoom: 'month',
                            dashboardFilters: {
                                dimensions: [],
                                metrics: [],
                                tableCalculations: [],
                            },
                            parameters: { currency: 'EUR' },
                        }}
                    />
                </MemoryRouter>
            </MantineBaseProvider>
        );
        const { rerender } = render(view('revenue'));
        fireEvent.change(screen.getByLabelText('Ask a question'), {
            target: { value: 'Run it' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await screen.findByRole('button', { name: 'Approve' });
        rerender(view('other-dashboard'));
        fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
        await waitFor(() => expect(decideApproval).toHaveBeenCalled());
        await waitFor(() =>
            expect(streamThreadTurn).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    pinnedContext: { kind: 'dashboard', slug: 'revenue' },
                    resumeApproved: {
                        approvalUuid: 'approval-1',
                        input: { sql: 'select 1' },
                        tool: 'run_sql',
                    },
                }),
                expect.any(Function),
            ),
        );
        expect(vi.mocked(streamThreadTurn).mock.calls[1][0]).not.toHaveProperty(
            'userText',
        );
    });
});
