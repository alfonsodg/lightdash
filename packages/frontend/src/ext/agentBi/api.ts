// Typed fetch wrappers for the agent-bi extension HTTP API.
// Base path: /api/ext/v1. All responses follow { status, results }.
type ExtResponse<T> = {
    results: T;
    status: string;
};

export interface AgentBiThread {
    createdAt: string;
    createdBy: string;
    organizationUuid: string;
    projectUuid: string;
    threadUuid: string;
    title: string;
    updatedAt: string;
}

export interface AgentBiMessage {
    content: string;
    createdAt: string;
    messageUuid: string;
    role: 'assistant' | 'system' | 'tool' | 'user';
    threadUuid: string;
}

export interface AgentBiSkill {
    createdAt: string;
    enabled: boolean;
    manifest: unknown;
    projectUuid: string;
    skillUuid: string;
    slug: string;
    updatedAt: string;
    version: string;
}

const base = '/api/ext/v1';

const parseBody = async <T>(response: Response): Promise<T> => {
    if (!response.ok) {
        let message = 'Request failed';
        try {
            const errorBody = (await response.json()) as {
                message?: string;
            };
            if (typeof errorBody.message === 'string') {
                message = errorBody.message;
            }
        } catch {
            message = 'Request failed';
        }
        throw new Error(message);
    }
    return response.json() as Promise<T>;
};

export const fetchAgentBiHealth = async (): Promise<boolean> => {
    const response = await fetch(`${base}/health`);
    if (!response.ok) {
        return false;
    }
    const body = (await response.json()) as ExtResponse<{ enabled: boolean }>;
    return body.results.enabled === true;
};

export const fetchThreads = async (
    projectUuid: string,
): Promise<AgentBiThread[]> => {
    const response = await fetch(`${base}/projects/${projectUuid}/threads`);
    const body = await parseBody<ExtResponse<AgentBiThread[]>>(response);
    return body.results;
};

export const createThread = async (
    projectUuid: string,
    title: string,
): Promise<AgentBiThread> => {
    const response = await fetch(`${base}/projects/${projectUuid}/threads`, {
        body: JSON.stringify({ title }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
    });
    const body = await parseBody<ExtResponse<AgentBiThread>>(response);
    return body.results;
};

export const fetchMessages = async (
    projectUuid: string,
    threadUuid: string,
): Promise<AgentBiMessage[]> => {
    const response = await fetch(
        `${base}/projects/${projectUuid}/threads/${threadUuid}/messages`,
    );
    const body = await parseBody<ExtResponse<AgentBiMessage[]>>(response);
    return body.results;
};

export const fetchSkills = async (
    projectUuid: string,
): Promise<AgentBiSkill[]> => {
    const response = await fetch(`${base}/projects/${projectUuid}/skills`);
    const body = await parseBody<ExtResponse<AgentBiSkill[]>>(response);
    return body.results;
};

export const createSkill = async (
    projectUuid: string,
    input: { manifest: unknown; slug: string; version?: string },
): Promise<AgentBiSkill> => {
    const response = await fetch(`${base}/projects/${projectUuid}/skills`, {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
    });
    const body = await parseBody<ExtResponse<AgentBiSkill>>(response);
    return body.results;
};

export const deleteSkill = async (
    projectUuid: string,
    skillUuid: string,
): Promise<void> => {
    const response = await fetch(
        `${base}/projects/${projectUuid}/skills/${skillUuid}`,
        { method: 'DELETE' },
    );
    await parseBody<ExtResponse<{ skillUuid: string }>>(response);
};

export const decideApproval = async (
    projectUuid: string,
    threadUuid: string,
    approvalUuid: string,
    decision: 'approved' | 'rejected',
): Promise<unknown> => {
    const response = await fetch(
        `${base}/projects/${projectUuid}/threads/${threadUuid}/approvals/${approvalUuid}`,
        {
            body: JSON.stringify({ decision }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
        },
    );
    const body = await parseBody<ExtResponse<unknown>>(response);
    return body.results;
};
