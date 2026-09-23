import { describe, expect, it } from "vitest";
import { mergeRefreshedMessages, upsertBoundedMessage, upsertBoundedMessageGroup, upsertMessage } from "./message-state";

type TestMessage = {
  id: string;
  createdAt: string;
  body: string;
  reactions?: number;
};

const message = (index: number): TestMessage => ({
  id: `message-${String(index).padStart(4, "0")}`,
  createdAt: new Date(Date.UTC(2026, 8, 22, 12, 0, index)).toISOString(),
  body: `message ${index}`,
});

describe("message state", () => {
  it("keeps a large busy-room history unique and chronological", () => {
    let messages = Array.from({ length: 1_000 }, (_, index) => message(index));

    messages = upsertMessage(messages, { ...message(500), reactions: 3 });
    messages = upsertMessage(messages, message(1_001));
    messages = upsertMessage(messages, message(1_000));

    expect(messages).toHaveLength(1_002);
    expect(new Set(messages.map(({ id }) => id)).size).toBe(messages.length);
    expect(messages.at(-2)?.id).toBe("message-1000");
    expect(messages.at(-1)?.id).toBe("message-1001");
    expect(messages.find(({ id }) => id === "message-0500")?.reactions).toBe(3);
  });

  it("reconciles delayed send responses without duplicates or chronology drift", () => {
    let messages = [
      { ...message(10), body: "realtime copy" },
      message(11),
    ];

    messages = upsertMessage(messages, {
      ...message(10),
      body: "authoritative response",
      reactions: 2,
    });
    messages = upsertMessage(messages, message(9));

    expect(messages.map(({ id }) => id)).toEqual([
      "message-0009",
      "message-0010",
      "message-0011",
    ]);
    expect(messages.filter(({ id }) => id === "message-0010")).toEqual([
      expect.objectContaining({
        body: "authoritative response",
        reactions: 2,
      }),
    ]);
  });

  it("bounds a busy channel while retaining the newest messages", () => {
    let messages = Array.from({ length: 100 }, (_, index) => message(index));

    for (let index = 100; index < 1_100; index += 1) {
      messages = upsertBoundedMessage(messages, message(index), 100);
    }

    expect(messages).toHaveLength(100);
    expect(messages[0].id).toBe("message-1000");
    expect(messages.at(-1)?.id).toBe("message-1099");
    expect(new Set(messages.map(({ id }) => id)).size).toBe(100);
  });

  it("does not let reconnect history erase newer realtime frames", () => {
    const refreshed = [message(1), message(2)];
    const current = [
      { ...message(2), body: "updated over realtime" },
      message(3),
    ];

    expect(mergeRefreshedMessages(refreshed, current)).toEqual([
      message(1),
      { ...message(2), body: "updated over realtime" },
      message(3),
    ]);
  });

  it("keeps refreshed fields authoritative and preserves the server window bound", () => {
    const previous = Array.from({ length: 100 }, (_, index) => message(index));
    const refreshed = Array.from({ length: 100 }, (_, index) => ({
      ...message(index + 1),
      body: index === 49 ? "deleted on server" : message(index + 1).body,
    }));
    const realtime = [message(101)];

    const merged = mergeRefreshedMessages(refreshed, realtime);

    expect(merged).toHaveLength(100);
    expect(merged.some(({ id }) => id === previous[0].id)).toBe(false);
    expect(merged.find(({ id }) => id === "message-0050")?.body).toBe("deleted on server");
    expect(merged.at(-1)?.id).toBe("message-0101");
  });

  it("bounds transient presence rows without evicting chat history or duplicating frames", () => {
    const history = Array.from({ length: 100 }, (_, index) => message(index));
    let messages = history;
    const isPresence = (item: TestMessage) => item.id.startsWith("presence-");

    for (let index = 0; index < 200; index += 1) {
      messages = upsertBoundedMessageGroup(messages, {
        ...message(index + 200),
        id: `presence-${index}`,
      }, isPresence, 20);
    }
    messages = upsertBoundedMessageGroup(messages, {
      ...message(399),
      id: "presence-199",
      body: "duplicate frame updated",
    }, isPresence, 20);

    expect(messages).toHaveLength(120);
    expect(messages.filter(isPresence)).toHaveLength(20);
    expect(messages.filter((item) => item.id.startsWith("message-"))).toEqual(history);
    expect(messages.filter((item) => item.id === "presence-199")).toEqual([
      expect.objectContaining({ body: "duplicate frame updated" }),
    ]);
  });
});