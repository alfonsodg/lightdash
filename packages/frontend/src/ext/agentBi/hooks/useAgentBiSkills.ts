import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { createSkill, deleteSkill, fetchSkills } from '../api';

export const useAgentBiSkills = (projectUuid: string) => {
    const queryClient = useQueryClient();
    const query = useQuery({
        enabled: projectUuid.length > 0,
        queryFn: () => fetchSkills(projectUuid),
        queryKey: ['agent-bi-skills', projectUuid],
        staleTime: 30_000,
    });
    const create = useCallback(
        async (input: {
            manifest: unknown;
            slug: string;
            version?: string;
        }) => {
            const created = await createSkill(projectUuid, input);
            await queryClient.invalidateQueries({
                queryKey: ['agent-bi-skills', projectUuid],
            });
            return created;
        },
        [projectUuid, queryClient],
    );
    const remove = useCallback(
        async (skillUuid: string) => {
            await deleteSkill(projectUuid, skillUuid);
            await queryClient.invalidateQueries({
                queryKey: ['agent-bi-skills', projectUuid],
            });
        },
        [projectUuid, queryClient],
    );
    return { ...query, create, remove };
};
