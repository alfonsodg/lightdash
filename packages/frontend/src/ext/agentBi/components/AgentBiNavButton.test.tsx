// Slice 1 (TDD): AgentBiNavButton visibility gate.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useApp from '../../../providers/App/useApp';
import MantineBaseProvider from '../../../providers/MantineBaseProvider';
import AgentBiNavButton from './AgentBiNavButton';

vi.mock('../hooks/useAgentBiHealth', () => ({
    useAgentBiHealth: () => ({ isEnabled: true }),
}));

vi.mock('../../../providers/App/useApp', () => ({ default: vi.fn() }));

describe('AgentBiNavButton', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(useApp).mockReturnValue({
            user: {
                data: {
                    ability: { can: () => true },
                    organizationUuid: 'organization-1',
                },
            },
        } as unknown as ReturnType<typeof useApp>);
    });

    it('renders the Ask AI button when enabled and allowed', () => {
        const queryClient = new QueryClient();
        render(
            <QueryClientProvider client={queryClient}>
                <MantineBaseProvider env="test">
                    <MemoryRouter>
                        <AgentBiNavButton projectUuid="project-1" />
                    </MemoryRouter>
                </MantineBaseProvider>
            </QueryClientProvider>,
        );
        expect(
            screen.getByRole('button', { name: /ask ai/i }),
        ).toBeInTheDocument();
    });
});
