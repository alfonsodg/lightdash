// Human-in-the-loop gate: tools that need confirmation suspend the run
// with an approval request message; the run resumes on approve/reject.
import {
    ThreadStoreError,
    type MessageRecord,
    type ThreadAccess,
    type ThreadStore,
} from './threadRepository';

export type ApprovalMessageStore = Pick<
    ThreadStore,
    'createMessage' | 'getMessage' | 'updateMessageContent'
>;

export type ApprovalStatus = 'approved' | 'pending' | 'rejected';

export interface ApprovalRequest {
    approvalUuid: string;
    decidedBy: string | null;
    input: unknown;
    requestedBy: string | null;
    status: ApprovalStatus;
    threadUuid: string;
    tool: string;
}

export type ApprovalGateErrorCode =
    | 'ALREADY_DECIDED'
    | 'FORBIDDEN'
    | 'INVALID_INPUT'
    | 'NOT_FOUND';

export class ApprovalGateError extends Error {
    readonly code: ApprovalGateErrorCode;

    constructor(code: ApprovalGateErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = 'ApprovalGateError';
    }
}

export const APPROVAL_MESSAGE_KIND = 'approval_request';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

export const parseApprovalContent = (
    messageUuid: string,
    threadUuid: string,
    content: string,
): ApprovalRequest | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content) as unknown;
    } catch {
        return null;
    }
    if (!isRecord(parsed) || parsed.kind !== APPROVAL_MESSAGE_KIND) {
        return null;
    }
    const { status } = parsed;
    if (
        status !== 'pending' &&
        status !== 'approved' &&
        status !== 'rejected'
    ) {
        return null;
    }
    if (typeof parsed.tool !== 'string' || parsed.tool === '') {
        return null;
    }
    const requestedBy =
        typeof parsed.requestedBy === 'string' ? parsed.requestedBy : null;
    const decidedBy =
        typeof parsed.decidedBy === 'string' ? parsed.decidedBy : null;
    return {
        approvalUuid: messageUuid,
        decidedBy,
        input: parsed.input ?? null,
        requestedBy,
        status,
        threadUuid,
        tool: parsed.tool,
    };
};

export const isApprovalMessage = (message: MessageRecord): boolean =>
    parseApprovalContent(
        message.messageUuid,
        message.threadUuid,
        message.content,
    ) !== null;

export const listPendingApprovals = (
    messages: MessageRecord[],
): ApprovalRequest[] => {
    const pending: ApprovalRequest[] = [];
    for (const message of messages) {
        const request = parseApprovalContent(
            message.messageUuid,
            message.threadUuid,
            message.content,
        );
        if (request !== null && request.status === 'pending') {
            pending.push(request);
        }
    }
    return pending;
};

const runStore = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
        return await action();
    } catch (error) {
        if (error instanceof ThreadStoreError) {
            throw new ApprovalGateError(error.code, error.message);
        }
        throw error;
    }
};

export const requestApproval = async (
    store: ApprovalMessageStore,
    input: {
        access: ThreadAccess;
        input: unknown;
        threadUuid: string;
        tool: string;
    },
): Promise<ApprovalRequest> => {
    if (input.tool.trim() === '') {
        throw new ApprovalGateError('INVALID_INPUT', 'Tool name is required.');
    }
    const envelope = JSON.stringify({
        decidedBy: null,
        input: input.input ?? null,
        kind: APPROVAL_MESSAGE_KIND,
        requestedBy: input.access.requesterUuid,
        status: 'pending',
        tool: input.tool,
    });
    const message = await runStore(() =>
        store.createMessage(
            {
                content: envelope,
                role: 'assistant',
                threadUuid: input.threadUuid,
            },
            input.access,
        ),
    );
    const request = parseApprovalContent(
        message.messageUuid,
        message.threadUuid,
        message.content,
    );
    if (request === null) {
        throw new ApprovalGateError(
            'INVALID_INPUT',
            'Approval request could not be recorded.',
        );
    }
    return request;
};

export const resolveApproval = async (
    store: ApprovalMessageStore,
    input: {
        access: ThreadAccess;
        approvalUuid: string;
        decision: 'approved' | 'rejected';
    },
): Promise<ApprovalRequest> => {
    const message = await runStore(() =>
        store.getMessage(input.approvalUuid, input.access),
    );
    if (message === null) {
        throw new ApprovalGateError('NOT_FOUND', 'Approval was not found.');
    }
    const request = parseApprovalContent(
        message.messageUuid,
        message.threadUuid,
        message.content,
    );
    if (request === null) {
        throw new ApprovalGateError(
            'INVALID_INPUT',
            'Message is not an approval request.',
        );
    }
    if (request.status !== 'pending') {
        throw new ApprovalGateError(
            'ALREADY_DECIDED',
            'Approval was already decided.',
        );
    }
    const updated = await runStore(() =>
        store.updateMessageContent(
            message.messageUuid,
            JSON.stringify({
                decidedBy: input.access.requesterUuid,
                input: request.input,
                kind: APPROVAL_MESSAGE_KIND,
                requestedBy: request.requestedBy,
                status: input.decision,
                tool: request.tool,
            }),
            input.access,
        ),
    );
    const resolved = parseApprovalContent(
        updated.messageUuid,
        updated.threadUuid,
        updated.content,
    );
    if (resolved === null || resolved.status !== input.decision) {
        throw new ApprovalGateError(
            'INVALID_INPUT',
            'Approval decision was not recorded.',
        );
    }
    return resolved;
};
