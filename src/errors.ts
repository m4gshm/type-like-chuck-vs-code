export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
