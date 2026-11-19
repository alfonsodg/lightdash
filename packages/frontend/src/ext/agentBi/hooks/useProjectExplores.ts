import { useQuery } from '@tanstack/react-query';
import { fetchProjectExplores, type AgentBiExploreSummary } from '../api';

/** Fetches queryable explores, dimensions, and metrics for the active project. */
export const useProjectExplores = (projectUuid: string) =>
    useQuery<AgentBiExploreSummary[]>({
        enabled: projectUuid.length > 0,
        queryFn: () => fetchProjectExplores(projectUuid),
        queryKey: ['agent-bi-explores', projectUuid],
        staleTime: 60_000,
    });
