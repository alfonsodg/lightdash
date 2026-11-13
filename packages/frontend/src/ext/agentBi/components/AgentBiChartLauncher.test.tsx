import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AgentBiChartLauncher from './AgentBiChartLauncher';

vi.mock('react-router', () => ({
    useParams: () => ({ projectUuid: 'proj-1' }),
}));

vi.mock('../../../ee/providers/Embed/useIsEmbedded', () => ({
    default: () => false,
}));

vi.mock('../../../providers/App/useApp', () => ({
    default: () => ({
        user: {
            data: {
                ability: { can: () => true },
                organizationUuid: 'org-1',
            },
        },
    }),
}));

vi.mock('../../../features/explorer/store', () => ({
    selectSavedChart: () => ({ parameters: {}, slug: 'orders-chart' }),
    useExplorerSelector: (selector: () => unknown) => selector(),
}));

vi.mock('../hooks/useAgentBiHealth', () => ({
    useAgentBiHealth: () => ({ isEnabled: true }),
}));

describe('AgentBiChartLauncher', () => {
    it('renders the chart contextual launcher when enabled and authorized', () => {
        render(
            <MantineProvider>
                <AgentBiChartLauncher />
            </MantineProvider>,
        );
        expect(
            screen.getByRole('button', { name: 'Ask about this chart' }),
        ).toBeInTheDocument();
    });
});
