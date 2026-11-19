import { createContext, useContext } from 'react';
import { enMessages } from './locales/en';
import { esMessages, type AgentBiMessageKey } from './locales/es';

export type AgentBiLocale = 'es' | 'en';

export const AGENT_BI_LOCALE_STORAGE_KEY = 'agent-bi-locale';

const DICTIONARIES: Record<AgentBiLocale, Record<AgentBiMessageKey, string>> = {
    en: enMessages,
    es: esMessages,
};

/** Returns the localized Agent BI message for the given locale and key. */
export const getAgentBiString = (
    locale: AgentBiLocale,
    key: AgentBiMessageKey,
): string => DICTIONARIES[locale][key];

export type AgentBiLocaleContextValue = {
    locale: AgentBiLocale;
    setLocale: (next: AgentBiLocale) => void;
    t: (key: AgentBiMessageKey) => string;
};

const defaultLocaleContext: AgentBiLocaleContextValue = {
    locale: 'es',
    setLocale: () => {},
    t: (key) => getAgentBiString('es', key),
};

export const AgentBiLocaleContext =
    createContext<AgentBiLocaleContextValue>(defaultLocaleContext);

/** Reads the active Agent BI locale, setter, and translator function. */
export const useAgentBiLocale = (): AgentBiLocaleContextValue =>
    useContext(AgentBiLocaleContext);
