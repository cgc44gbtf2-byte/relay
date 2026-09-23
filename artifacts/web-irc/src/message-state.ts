type TimestampedMessage = {
  id: string;
  createdAt: string;
};

function compareMessages(left: TimestampedMessage, right: TimestampedMessage): number {
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  return createdAtOrder || left.id.localeCompare(right.id);
}

export function upsertMessage<T extends TimestampedMessage>(messages: T[], incoming: T): T[] {
  const existingIndex = messages.findIndex((message) => message.id === incoming.id);
  if (existingIndex >= 0) {
    const updated = { ...messages[existingIndex], ...incoming };
    const next = messages.slice();
    next[existingIndex] = updated;
    const previous = messages[existingIndex - 1];
    const following = messages[existingIndex + 1];
    return (previous && compareMessages(previous, updated) > 0)
      || (following && compareMessages(updated, following) > 0)
      ? next.sort(compareMessages)
      : next;
  }

  if (!messages.length || compareMessages(messages[messages.length - 1], incoming) <= 0) {
    return [...messages, incoming];
  }
  return [...messages, incoming].sort(compareMessages);
}

export function upsertBoundedMessageGroup<T extends TimestampedMessage>(
  messages: T[],
  incoming: T,
  belongsToBoundedGroup: (message: T) => boolean,
  maxGroupLength: number,
): T[] {
  const next = upsertMessage(messages, incoming);
  let messagesToDrop = next.filter(belongsToBoundedGroup).length - Math.max(0, maxGroupLength);
  if (messagesToDrop <= 0) return next;

  return next.filter((message) => {
    if (messagesToDrop > 0 && belongsToBoundedGroup(message)) {
      messagesToDrop -= 1;
      return false;
    }
    return true;
  });
}

export function mergeRefreshedMessages<T extends TimestampedMessage>(
  refreshed: T[],
  messagesChangedDuringRefresh: T[],
  preservedHistory: T[] = [],
  maxLength = 100,
): T[] {
  const byId = new Map(preservedHistory.map((message) => [message.id, message]));
  for (const message of refreshed) {
    byId.set(message.id, message);
  }
  for (const message of messagesChangedDuringRefresh) {
    byId.set(message.id, { ...byId.get(message.id), ...message });
  }
  const merged = [...byId.values()].sort(compareMessages);
  return Number.isFinite(maxLength) && merged.length > maxLength
    ? merged.slice(-maxLength)
    : merged;
}