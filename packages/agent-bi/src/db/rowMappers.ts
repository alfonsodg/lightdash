/** Converts a database timestamp column value to an ISO-8601 string. */
export const toISOString = (value: unknown): string => {
    if (value instanceof Date) {
        return value.toISOString();
    }
    return String(value ?? '');
};
