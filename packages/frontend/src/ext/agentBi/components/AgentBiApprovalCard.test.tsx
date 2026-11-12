// Slice 1 (TDD): AgentBiApprovalCard approve/reject interactions.
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../testing/testUtils';
import AgentBiApprovalCard from './AgentBiApprovalCard';

describe('AgentBiApprovalCard', () => {
    it('shows the tool and input for a pending approval', () => {
        renderWithProviders(
            <AgentBiApprovalCard
                approvalUuid="approval-1"
                input={{ sql: 'SELECT 1' }}
                onDecide={() => {}}
                tool="run_sql"
            />,
        );
        expect(screen.getByText('run_sql')).toBeInTheDocument();
        expect(screen.getByText(/SELECT 1/)).toBeInTheDocument();
    });

    it('calls onDecide with approved', () => {
        const onDecide = vi.fn();
        renderWithProviders(
            <AgentBiApprovalCard
                approvalUuid="approval-1"
                input={{ sql: 'SELECT 1' }}
                onDecide={onDecide}
                tool="run_sql"
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: /approve/i }));
        expect(onDecide).toHaveBeenCalledWith('approved');
    });

    it('calls onDecide with rejected', () => {
        const onDecide = vi.fn();
        renderWithProviders(
            <AgentBiApprovalCard
                approvalUuid="approval-1"
                input={{ sql: 'SELECT 1' }}
                onDecide={onDecide}
                tool="run_sql"
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: /reject/i }));
        expect(onDecide).toHaveBeenCalledWith('rejected');
    });

    it('contains no brand copy', () => {
        const view = renderWithProviders(
            <AgentBiApprovalCard
                approvalUuid="approval-1"
                input={{ sql: 'SELECT 1' }}
                onDecide={() => {}}
                tool="run_sql"
            />,
        );
        const cardText =
            view.container.querySelector('[data-approval-uuid]')?.textContent ??
            '';
        expect(cardText.toLowerCase()).not.toContain('lightdash');
    });
});
