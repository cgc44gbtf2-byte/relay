import assert from "node:assert/strict";
import { describe, test } from "node:test";

process.env.TEST_DATABASE_URL ??= "postgresql://unit-test.invalid/relay_ws_unit";
const { Hub } = require("./ws") as typeof import("./ws");

type FakeSocket = {
  OPEN: number;
  readyState: number;
  events: unknown[];
  send: (payload: string) => void;
};

function socket(): FakeSocket {
  const value: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    events: [],
    send(payload) {
      value.events.push(JSON.parse(payload));
    },
  };
  return value;
}

function client(userId: string, fakeSocket: FakeSocket) {
  return {
    socket: fakeSocket,
    userId,
    channelIds: new Set<number>(),
    channelGenerations: new Map<number, number>(),
  };
}

describe("websocket channel removal", () => {
  test("notifies only authorized subscribers before cleaning subscriptions", () => {
    const hub = new Hub();
    const authorizedSocket = socket();
    const otherChannelSocket = socket();
    const nonSubscriberSocket = socket();
    const authorized = client("authorized", authorizedSocket);
    const otherChannelSubscriber = client("other-channel", otherChannelSocket);
    const nonSubscriber = client("not-subscribed", nonSubscriberSocket);
    const internals = hub as any;
    internals.clients.add(authorized);
    internals.clients.add(otherChannelSubscriber);
    internals.clients.add(nonSubscriber);
    internals.addChannelSubscription(authorized, 42);
    internals.addChannelSubscription(otherChannelSubscriber, 7);
    nonSubscriber.channelIds.add(42);

    hub.broadcastChannelRemoved(42);

    assert.deepEqual(authorizedSocket.events, [{ type: "channel_removed", channelId: 42 }]);
    assert.deepEqual(otherChannelSocket.events, []);
    assert.deepEqual(nonSubscriberSocket.events, []);
    assert.equal(authorized.channelIds.has(42), false);
    assert.equal(nonSubscriber.channelIds.has(42), false);
    assert.equal(nonSubscriber.channelGenerations.get(42), 1);
    assert.equal(internals.channelClients.has(42), false);
    assert.equal(otherChannelSubscriber.channelIds.has(7), true);
    hub.dispose();
  });
});

describe("websocket ticket cleanup", () => {
  test("rejects tickets at their expiration boundary", () => {
    const hub = new Hub();
    const internals = hub as any;
    internals.tickets.set("expired", {
      userId: "user",
      sessionId: "session",
      expiresAt: Date.now(),
    });

    assert.equal(hub.consumeTicket("expired"), null);
    assert.equal(internals.tickets.size, 0);
    hub.dispose();
  });

  test("bounds each sweep and eventually reaches later expired tickets", () => {
    const hub = new Hub();
    const internals = hub as any;
    internals.tickets.set("live-a", {
      userId: "user",
      sessionId: "session",
      expiresAt: 10_000,
    });
    internals.tickets.set("live-b", {
      userId: "user",
      sessionId: "session",
      expiresAt: 10_000,
    });
    internals.tickets.set("expired", {
      userId: "user",
      sessionId: "session",
      expiresAt: 1,
    });

    assert.equal(hub.cleanupExpiredTickets(5_000, 2), 0);
    assert.equal(internals.tickets.has("expired"), true);
    assert.equal(hub.cleanupExpiredTickets(5_000, 2), 1);
    assert.equal(internals.tickets.has("expired"), false);
    hub.dispose();
  });
});

describe("websocket multi-connection presence", () => {
  test("keeps a user connected while another socket remains", () => {
    const hub = new Hub();
    const internals = hub as any;
    const first = client("same-user", socket());
    const second = client("same-user", socket());
    internals.clients.add(first);
    internals.clients.add(second);

    internals.clients.delete(first);
    assert.equal(internals.hasConnectedUser("same-user"), true);

    internals.clients.delete(second);
    assert.equal(internals.hasConnectedUser("same-user"), false);
    hub.dispose();
  });
});