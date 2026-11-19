import { useQuery } from '@tanstack/react-query';
import { fetchMessages } from '../api';

export const useAgentBiMessages = (
    projectUuid: string,
    threadUuid: string | null,
) => {
    const query = useQuery({
        enabled: threadUuid !== null && threadUuid.length > 0,
        queryFn: () => fetchMessages(projectUuid, threadUuid ?? ''),
        queryKey: ['agent-bi-messages', projectUuid, threadUuid],
        staleTime: 15_000,
    });
    return query;
};
