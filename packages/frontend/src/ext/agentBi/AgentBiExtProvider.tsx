import { createContext, type FC, type PropsWithChildren } from 'react';
import { useAgentBiHealth } from './hooks/useAgentBiHealth';

type AgentBiExtContextValue = {
    isEnabled: boolean;
};

const AgentBiExtContext = createContext<AgentBiExtContextValue>({
    isEnabled: false,
});

export const AgentBiExtProvider: FC<PropsWithChildren> = ({ children }) => {
    const { isEnabled } = useAgentBiHealth();
    return (
        <AgentBiExtContext.Provider value={{ isEnabled }}>
            {children}
        </AgentBiExtContext.Provider>
    );
};
