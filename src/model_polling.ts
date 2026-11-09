/** How often the server's /v1/models list is re-checked for model changes. */
export const MODEL_POLL_INTERVAL_MS = 30_000;

/**
 * Stable key of a model list, used to detect server-side model changes:
 * the picker/auto-application logic runs only when the list actually changes,
 * so a dismissed picker is not shown again on every poll.
 */
export function modelIdsKey(models: readonly { id: string }[]): string {
  return models.map((m) => m.id).sort().join('\n');
}
