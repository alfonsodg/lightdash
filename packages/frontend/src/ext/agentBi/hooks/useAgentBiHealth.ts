// Health gate for the agent-bi extension: /api/ext/v1/health.
import { useQuery } from '@tanstack/react-query';
import { fetchAgentBiHealth } from '../api';

export const useAgentBiHealth = (options?: { enabled?: boolean }) => {
    const query = useQuery({
        enabled: options?.enabled ?? true,
        queryFn: fetchAgentBiHealth,
        queryKey: ['agent-bi-health'],
        staleTime: 60_000,
    });
    return { ...query, isEnabled: query.data === true };
};
