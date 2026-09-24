/**
 * Stable error response for requests that target a channel that does not exist.
 * Clients should use `code` for branching and treat `error` as display text.
 */
export const channelNotFoundError = {
  error: "Channel not found.",
  code: "CHANNEL_NOT_FOUND",
} as const;

/**
 * Stable error code for an existing channel that the caller can no longer access.
 * Clients should branch on `code` and treat `error` as display text.
 */
export function channelAccessRequiredError(message: string) {
  return {
    error: message,
    code: "CHANNEL_ACCESS_REQUIRED",
  } as const;
}
