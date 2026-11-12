// SSE streaming hook for the agent-bi turn endpoint.
// POSTs to /messages/stream and yields parsed events.
export type AgentBiStreamEvent =
    | { data: unknown; type: 'status' }
    | { data: unknown; type: 'tool_call' }
    | { data: unknown; type: 'tool_result' }
    | { data: unknown; type: 'chart_artifact' }
    | { data: unknown; type: 'approval_required' }
    | { data: unknown; type: 'text_delta' }
    | { data: unknown; type: 'done' }
    | { data: unknown; type: 'error' };

export type StreamInput = {
    pinnedContext?: { kind: 'chart' | 'dashboard'; slug: string } | null;
    projectUuid: string;
    resumeApproved?: {
        approvalUuid: string;
        input: unknown;
        tool: string;
    };
    runtimeOverrides?: {
        activeTab?: string;
        dateZoom?: string;
        filters?: Record<string, unknown>;
        parameters?: Record<string, unknown>;
    } | null;
    threadUuid: string;
    userText?: string;
};

const parseEvent = (block: string): AgentBiStreamEvent | null => {
    const lines = block.split('\n');
    let type: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
        if (line.startsWith('event:')) {
            type = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trim());
        }
    }
    if (type === undefined) {
        return null;
    }
    let data: unknown = null;
    try {
        data = JSON.parse(dataLines.join('') || 'null');
    } catch {
        data = dataLines.join('');
    }
    const known = [
        'approval_required',
        'chart_artifact',
        'done',
        'error',
        'status',
        'text_delta',
        'tool_call',
        'tool_result',
    ];
    if (!known.includes(type)) {
        return null;
    }
    return { data, type: type as AgentBiStreamEvent['type'] };
};

export const streamThreadTurn = async (
    input: StreamInput,
    onEvent: (event: AgentBiStreamEvent) => void,
    signal?: AbortSignal,
): Promise<void> => {
    const response = await fetch(
        `/api/ext/v1/projects/${input.projectUuid}/threads/${input.threadUuid}/messages/stream`,
        {
            body: JSON.stringify({
                pinnedContext: input.pinnedContext,
                resumeApproved: input.resumeApproved,
                runtimeOverrides: input.runtimeOverrides,
                userText: input.userText,
            }),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
            signal,
        },
    );
    if (!response.ok || response.body === null) {
        throw new Error('Stream request failed');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() ?? '';
            for (const block of blocks) {
                const event = parseEvent(block);
                if (event !== null) {
                    onEvent(event);
                }
            }
        }
        if (buffer.trim().length > 0) {
            const event = parseEvent(buffer);
            if (event !== null) {
                onEvent(event);
            }
        }
    } finally {
        reader.releaseLock();
    }
};
