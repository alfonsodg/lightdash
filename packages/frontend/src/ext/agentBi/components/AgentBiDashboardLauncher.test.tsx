import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MantineBaseProvider from '../../../providers/MantineBaseProvider';
import AgentBiDashboardLauncher from './AgentBiDashboardLauncher';

const workspace = vi.hoisted(() => vi.fn(() => null));
vi.mock('../pages/AgentBiWorkspacePage', () => ({ default: workspace }));
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
vi.mock('../hooks/useAgentBiHealth', () => ({
    useAgentBiHealth: () => ({ isEnabled: true }),
}));
vi.mock('../hooks/useAgentBiDashboardContext', () => ({
    useAgentBiDashboardContext: () => ({ dashboardSlug: 'revenue' }),
}));
vi.mock('../../../ee/providers/Embed/useIsEmbedded', () => ({
    default: () => false,
}));

describe('AgentBiDashboardLauncher', () => {
    it('opens the workspace with live dashboard context', () => {
        render(
            <MantineBaseProvider env="test">
                <AgentBiDashboardLauncher projectUuid="project-1" />
            </MantineBaseProvider>,
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Ask about this dashboard' }),
        );
        expect(workspace).toHaveBeenCalledWith(
            expect.objectContaining({
                dashboardContext: { dashboardSlug: 'revenue' },
            }),
            undefined,
        );
    });
});
