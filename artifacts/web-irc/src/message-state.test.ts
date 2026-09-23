import { describe, expect, it } from "vitest";
import { mergeRefreshedMessages, upsertMessage } from "./message-state";

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
});