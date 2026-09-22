/**
 * Stable error response for requests that target a channel that does not exist.
 * Clients should use `code` for branching and treat `error` as display text.
 */
export const channelNotFoundError = {
  error: "Channel not found.",
  code: "CHANNEL_NOT_FOUND",
} as const;
