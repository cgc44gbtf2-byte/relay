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

describe("websocket channel-list invalidation", () => {
  test("notifies authorized private-workspace users but not another workspace or unauthorized user", async () => {
    const channel = { id: 42, isPrivate: true, communityId: 7 };
    const allowedUsers = new Set(["workspace-member", "private-channel-member"]);
    const checkedUsers: string[] = [];
    const hub = new Hub(
      async (channelId) => channelId === channel.id ? channel : null,
      async (_channel, userId) => {
        checkedUsers.push(userId);
        return allowedUsers.has(userId);
      },
    );
    const workspaceMemberSocket = socket();
    const privateChannelMemberSocket = socket();
    const otherWorkspaceSocket = socket();
    const unauthorizedSocket = socket();
    const duplicateWorkspaceMemberSocket = socket();
    const internals = hub as any;
    internals.clients.add(client("workspace-member", workspaceMemberSocket));
    internals.clients.add(client("private-channel-member", privateChannelMemberSocket));
    internals.clients.add(client("other-workspace-member", otherWorkspaceSocket));
    internals.clients.add(client("unauthorized", unauthorizedSocket));
    internals.clients.add(client("workspace-member", duplicateWorkspaceMemberSocket));

    await hub.broadcastChannelListChanged(channel.id);

    const event = [{ type: "channel_list_changed" }];
    assert.deepEqual(workspaceMemberSocket.events, event);
    assert.deepEqual(privateChannelMemberSocket.events, event);
    assert.deepEqual(duplicateWorkspaceMemberSocket.events, event);
    assert.deepEqual(otherWorkspaceSocket.events, []);
    assert.deepEqual(unauthorizedSocket.events, []);
    assert.deepEqual(checkedUsers.sort(), [
      "other-workspace-member",
      "private-channel-member",
      "unauthorized",
      "workspace-member",
    ]);
    hub.dispose();
  });

  test("keeps public global community discovery invalidation available to every legitimate reader", async () => {
    const channel = { id: 84, isPrivate: false, communityId: 9 };
    const hub = new Hub(
      async () => channel,
      async () => true,
    );
    const communityMemberSocket = socket();
    const globalCommunityUserSocket = socket();
    const internals = hub as any;
    internals.clients.add(client("community-member", communityMemberSocket));
    internals.clients.add(client("global-community-user", globalCommunityUserSocket));

    await hub.broadcastChannelListChanged(channel.id);

    const event = [{ type: "channel_list_changed" }];
    assert.deepEqual(communityMemberSocket.events, event);
    assert.deepEqual(globalCommunityUserSocket.events, event);
    hub.dispose();
  });

  test("does not globally invalidate a channel that no longer exists", async () => {
    const hub = new Hub(
      async () => null,
      async () => true,
    );
    const connectedSocket = socket();
    (hub as any).clients.add(client("connected", connectedSocket));

    await hub.broadcastChannelListChanged(404);

    assert.deepEqual(connectedSocket.events, []);
    hub.dispose();
  });

  test("bounds concurrent authorization checks and skips clients disconnected while checking", async () => {
    const channel = { id: 85, isPrivate: true, communityId: 10 };
    let activeChecks = 0;
    let maximumActiveChecks = 0;
    const releases: Array<() => void> = [];
    const hub = new Hub(
      async () => channel,
      async () => {
        activeChecks++;
        maximumActiveChecks = Math.max(maximumActiveChecks, activeChecks);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeChecks--;
        return true;
      },
    );
    const internals = hub as any;
    const clients = Array.from({ length: 12 }, (_, index) => {
      const connected = client(`user-${index}`, socket());
      internals.clients.add(connected);
      return connected;
    });

    const broadcast = hub.broadcastChannelListChanged(channel.id);
    while (releases.length < 8) await new Promise((resolve) => setImmediate(resolve));
    internals.clients.delete(clients[0]);
    while (releases.length > 0 || activeChecks > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await broadcast;

    assert.equal(maximumActiveChecks, 8);
    assert.deepEqual((clients[0].socket as unknown as FakeSocket).events, []);
    for (const connected of clients.slice(1)) {
      assert.deepEqual((connected.socket as unknown as FakeSocket).events, [
        { type: "channel_list_changed" },
      ]);
    }
    hub.dispose();
  });
});

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