import dayjs from 'dayjs';
import 'dayjs/locale/es';
import {
    useCallback,
    useEffect,
    useState,
    type FC,
    type PropsWithChildren,
} from 'react';
import {
    AGENT_BI_LOCALE_STORAGE_KEY,
    AgentBiLocaleContext,
    getAgentBiString,
    type AgentBiLocale,
} from './agentBiLocale';
import { type AgentBiMessageKey } from './locales/es';

const readStoredLocale = (): AgentBiLocale => {
    try {
        const stored = localStorage.getItem(AGENT_BI_LOCALE_STORAGE_KEY);
        if (stored === 'en' || stored === 'es') {
            return stored;
        }
    } catch {
        // Ignore storage access errors in SSR or restricted environments.
    }
    return 'es';
};

/** Provides persisted ES/EN localization state for Agent BI components. */
export const AgentBiLocaleProvider: FC<PropsWithChildren> = ({ children }) => {
    const [locale, setLocaleState] = useState<AgentBiLocale>(() =>
        readStoredLocale(),
    );

    useEffect(() => {
        dayjs.locale(locale);
    }, [locale]);

    const setLocale = useCallback((next: AgentBiLocale) => {
        setLocaleState(next);
        try {
            localStorage.setItem(AGENT_BI_LOCALE_STORAGE_KEY, next);
        } catch {
            // Ignore storage quota errors.
        }
    }, []);

    const t = useCallback(
        (key: AgentBiMessageKey) => getAgentBiString(locale, key),
        [locale],
    );

    return (
        <AgentBiLocaleContext.Provider value={{ locale, setLocale, t }}>
            {children}
        </AgentBiLocaleContext.Provider>
    );
};
