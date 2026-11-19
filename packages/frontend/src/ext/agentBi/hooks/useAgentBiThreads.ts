// Slice 1 (TDD red): thread list + create covered by useAgentBiThreads.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { createThread, fetchThreads } from '../api';

export const useAgentBiThreads = (projectUuid: string) => {
    const queryClient = useQueryClient();
    const query = useQuery({
        enabled: projectUuid.length > 0,
        queryFn: () => fetchThreads(projectUuid),
        queryKey: ['agent-bi-threads', projectUuid],
        staleTime: 30_000,
    });
    const create = useCallback(
        async (title: string) => {
            const created = await createThread(projectUuid, title);
            await queryClient.invalidateQueries({
                queryKey: ['agent-bi-threads', projectUuid],
            });
            return created;
        },
        [projectUuid, queryClient],
    );
    return { ...query, create };
};
