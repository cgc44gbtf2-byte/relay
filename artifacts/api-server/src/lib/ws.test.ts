import assert from "node:assert/strict";
import { describe, test } from "node:test";

process.env.TEST_DATABASE_URL ??= "postgresql://unit-test.invalid/relay_ws_unit";
const { Hub } = require("./ws") as typeof import("./ws");

type FakeSocket = {
  OPEN: number;
  readyState: number;
  events: unknown[];
  closeCalls: Array<{ code?: number; reason?: string }>;
  send: (payload: string) => void;
  close: (code?: number, reason?: string) => void;
};

function socket(): FakeSocket {
  const value: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    events: [],
    closeCalls: [],
    send(payload) {
      value.events.push(JSON.parse(payload));
    },
    close(code, reason) {
      value.closeCalls.push({ code, reason });
    },
  };
  return value;
}

function client(userId: string, fakeSocket: FakeSocket, sessionId = "session") {
  return {
    socket: fakeSocket,
    userId,
    sessionId,
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
  test("issues unpredictable tickets and consumes each one only once", () => {
    const hub = new Hub();
    try {
      const issuedAt = Date.now();
      const ticket = hub.issueTicket("first-user", "first-session");
      assert.match(ticket, /^[0-9a-f-]{36}$/i);
      const consumed = hub.consumeTicket(ticket);
      assert.ok(consumed);
      assert.equal(consumed.userId, "first-user");
      assert.equal(consumed.sessionId, "first-session");
      assert.ok(consumed.expiresAt >= issuedAt + 60_000 && consumed.expiresAt <= Date.now() + 60_000);
      assert.equal(hub.consumeTicket(ticket), null);
      assert.equal(hub.consumeTicket("unknown"), null);
    } finally {
      hub.dispose();
    }
  });

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
  test("retries an isolated rejected presence save without another socket event", async (t) => {
    const { db, usersTable } = require("@workspace/db") as typeof import("@workspace/db");
    const hub = new Hub();
    t.after(() => hub.dispose());
    const internals = hub as any;
    type Status = "online" | "offline";
    let storedStatus: Status = "offline";
    const writes: Array<{ status: Status; commit: () => void; reject: (error: Error) => void }> = [];

    t.mock.method(db, "update", (table: unknown) => {
      assert.equal(table, usersTable);
      return {
        set: ({ status }: { status: Status }) => ({
          where: () => new Promise<void>((resolve, reject) => {
            writes.push({
              status,
              commit: () => {
                storedStatus = status;
                resolve();
              },
              reject,
            });
          }),
        }),
      };
    });

    const waitFor = async (predicate: () => boolean, message: string) => {
      const deadline = Date.now() + 1_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    const connected = client("retry-user", socket());
    internals.registerClient(connected);
    internals.updatePresence(connected.userId);
    await waitFor(() => writes.length === 1, "the initial presence save should start");
    assert.equal(writes[0].status, "online");

    writes[0].reject(new Error("temporary presence-save failure"));
    await waitFor(() => writes.length === 2, "a retry should run without another socket event");
    assert.equal(writes[1].status, "online");
    writes[1].commit();
    await waitFor(() => internals.presenceWrites.size === 0, "the recovered presence queue should clear");

    assert.equal(storedStatus, "online");
    assert.equal(internals.hasConnectedUser(connected.userId), true);

    internals.unregisterClient(connected);
    internals.updatePresence(connected.userId);
    await waitFor(() => writes.length === 3, "the last disconnect should start an offline save");
    assert.equal(writes[2].status, "offline");
    writes[2].reject(new Error("temporary presence-save failure"));
    await waitFor(() => writes.length === 4, "the offline save should retry without another socket event");
    assert.equal(writes[3].status, "offline");
    writes[3].commit();
    await waitFor(() => internals.presenceWrites.size === 0, "the offline recovery queue should clear");

    assert.equal(storedStatus, "offline");
    assert.equal(internals.hasConnectedUser(connected.userId), false);
  });

  test("recomputes presence after socket changes during retry backoff", async (t) => {
    const { db, usersTable } = require("@workspace/db") as typeof import("@workspace/db");
    const hub = new Hub();
    t.after(() => hub.dispose());
    const internals = hub as any;
    type Status = "online" | "offline";
    const writes: Array<{ status: Status; commit: () => void; reject: (error: Error) => void }> = [];

    t.mock.method(db, "update", (table: unknown) => {
      assert.equal(table, usersTable);
      return {
        set: ({ status }: { status: Status }) => ({
          where: () => new Promise<void>((resolve, reject) => {
            writes.push({ status, commit: resolve, reject });
          }),
        }),
      };
    });

    const waitFor = async (predicate: () => boolean, message: string) => {
      const deadline = Date.now() + 1_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    const connected = client("changing-user", socket());
    internals.registerClient(connected);
    internals.updatePresence(connected.userId);
    await waitFor(() => writes.length === 1, "the initial presence save should start");
    writes[0].reject(new Error("temporary presence-save failure"));
    await waitFor(
      () => internals.presenceRetryTimers.size === 1,
      "the failed save should enter its retry backoff",
    );

    internals.unregisterClient(connected);
    internals.updatePresence(connected.userId);
    await waitFor(() => writes.length === 2, "the queued save should start after the socket closes");
    assert.equal(writes[1].status, "offline", "the queued write must recompute current connection status");
    assert.equal(internals.presenceRetryTimers.size, 0, "a newer write should cancel the stale retry backoff");

    writes[1].commit();
    await waitFor(() => internals.presenceWrites.size === 0, "the serialized queue should clear");
    assert.equal(writes.length, 2, "the queued socket-change write should supersede the retry");
  });

  test("cancels pending presence retries when disposed", async (t) => {
    const { db, usersTable } = require("@workspace/db") as typeof import("@workspace/db");
    const hub = new Hub();
    t.after(() => hub.dispose());
    const internals = hub as any;
    const writes: Array<{ reject: (error: Error) => void }> = [];

    t.mock.method(db, "update", (table: unknown) => {
      assert.equal(table, usersTable);
      return {
        set: () => ({
          where: () => new Promise<void>((_resolve, reject) => writes.push({ reject })),
        }),
      };
    });

    const waitFor = async (predicate: () => boolean, message: string) => {
      const deadline = Date.now() + 1_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    const connected = client("disposed-user", socket());
    internals.registerClient(connected);
    internals.updatePresence(connected.userId);
    await waitFor(() => writes.length === 1, "the initial presence save should start");
    writes[0].reject(new Error("temporary presence-save failure"));
    await waitFor(() => internals.presenceRetryTimers.size === 1, "a retry should be scheduled");

    hub.dispose();
    await waitFor(() => internals.presenceWrites.size === 0, "disposal should clear the presence queue");
    assert.equal(internals.presenceRetryTimers.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(writes.length, 1, "disposing must prevent another database attempt");
  });

  test("stops retrying after the bounded number of presence attempts", async (t) => {
    const { db, usersTable } = require("@workspace/db") as typeof import("@workspace/db");
    const hub = new Hub();
    t.after(() => hub.dispose());
    const internals = hub as any;
    const writes: Array<{ reject: (error: Error) => void }> = [];

    t.mock.method(db, "update", (table: unknown) => {
      assert.equal(table, usersTable);
      return {
        set: () => ({
          where: () => new Promise<void>((_resolve, reject) => writes.push({ reject })),
        }),
      };
    });

    const waitFor = async (predicate: () => boolean, message: string) => {
      const deadline = Date.now() + 1_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    const connected = client("bounded-user", socket());
    internals.registerClient(connected);
    internals.updatePresence(connected.userId);
    await waitFor(() => writes.length === 1, "the initial presence save should start");
    writes[0].reject(new Error("temporary presence-save failure"));
    await waitFor(() => writes.length === 2, "the first retry should run");
    writes[1].reject(new Error("temporary presence-save failure"));
    await waitFor(() => writes.length === 3, "the final retry should run");
    writes[2].reject(new Error("temporary presence-save failure"));
    await waitFor(() => internals.presenceWrites.size === 0, "exhausted retries should clear the queue");

    assert.equal(writes.length, 3, "the initial attempt and two retries are the limit");
    assert.equal(internals.presenceRetryTimers.size, 0);
  });

  test("recovers a queued presence write after a rejected write and persists the last disconnect", async (t) => {
    const { db, usersTable } = require("@workspace/db") as typeof import("@workspace/db");
    const hub = new Hub();
    t.after(() => hub.dispose());
    const internals = hub as any;
    type Status = "online" | "offline";
    let storedStatus: Status = "offline";
    const writes: Array<{ status: Status; commit: () => void; reject: (error: Error) => void }> = [];

    t.mock.method(db, "update", (table: unknown) => {
      assert.equal(table, usersTable);
      return {
        set: ({ status }: { status: Status }) => ({
          where: () => new Promise<void>((resolve, reject) => {
            writes.push({
              status,
              commit: () => {
                storedStatus = status;
                resolve();
              },
              reject,
            });
          }),
        }),
      };
    });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const first = client("same-user", socket());
    const remaining = client("same-user", socket());
    internals.registerClient(first);
    internals.registerClient(remaining);
    internals.updatePresence(first.userId);
    await flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].status, "online");

    internals.unregisterClient(first);
    internals.updatePresence(first.userId);
    const queuedWrite = internals.presenceWrites.get(first.userId);
    await flush();
    assert.equal(writes.length, 1, "the socket change must wait for the pending write");

    writes[0].reject(new Error("temporary presence-save failure"));
    await flush();
    assert.equal(storedStatus, "offline", "a failed write must not persist its status");
    assert.equal(writes.length, 2, "the queued write must execute despite the earlier rejection");
    assert.equal(writes[1].status, "online", "the remaining socket must keep the user online");
    assert.equal(internals.hasConnectedUser(first.userId), true);
    assert.equal(internals.presenceWrites.get(first.userId), queuedWrite,
      "failed-write cleanup must not remove the pending replacement write");

    writes[1].commit();
    await flush();
    assert.equal(storedStatus, "online");
    assert.equal(internals.presenceWrites.size, 0, "the recovered queue must clear after persistence");

    internals.unregisterClient(remaining);
    internals.updatePresence(remaining.userId);
    await flush();
    assert.equal(writes.length, 3);
    assert.equal(writes[2].status, "offline");
    writes[2].commit();
    await flush();
    assert.equal(storedStatus, "offline", "closing the last socket must persist offline status");
    assert.equal(internals.hasConnectedUser(remaining.userId), false);
    assert.equal(internals.presenceWrites.size, 0);
  });

  test("serializes delayed presence writes across out-of-order tab closes and reconnects", async (t) => {
    const { db, usersTable } = require("@workspace/db") as typeof import("@workspace/db");
    const hub = new Hub();
    t.after(() => hub.dispose());
    const internals = hub as any;
    type Status = "online" | "offline";
    let storedStatus: Status = "offline";
    const writes: Array<{ status: Status; commit: () => void }> = [];

    // Capture the status at query execution, but persist it only when released.
    // An unserialized replacement online write could otherwise finish before
    // an older offline write and leave a connected user stored as offline.
    t.mock.method(db, "update", (table: unknown) => {
      assert.equal(table, usersTable);
      return {
        set: ({ status }: { status: Status }) => ({
          where: () => new Promise<void>((resolve) => {
            writes.push({
              status,
              commit: () => {
                storedStatus = status;
                resolve();
              },
            });
          }),
        }),
      };
    });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const connect = () => {
      const connected = client("same-user", socket());
      internals.registerClient(connected);
      internals.updatePresence(connected.userId);
      return connected;
    };
    const disconnect = (connected: ReturnType<typeof client>) => {
      internals.unregisterClient(connected);
      internals.updatePresence(connected.userId);
    };
    const commit = async (index: number, expected: Status) => {
      assert.equal(writes[index]?.status, expected);
      writes[index].commit();
      await flush();
    };

    const first = connect();
    await flush();
    assert.equal(writes.length, 1);
    const second = connect();
    disconnect(second); // The newer tab closes before the original tab.
    await flush();
    assert.equal(writes.length, 1, "overlapping writes must wait for the delayed first write");
    await commit(0, "online");
    await commit(1, "online");
    await commit(2, "online");
    assert.equal(writes.length, 3);
    assert.equal(storedStatus, "online");
    assert.equal(internals.hasConnectedUser("same-user"), true);

    disconnect(first);
    await flush();
    assert.equal(writes[3]?.status, "offline");
    const replacement = connect();
    const extraTab = connect();
    disconnect(extraTab);
    await flush();
    assert.equal(writes.length, 4, "replacement online writes cannot overtake a delayed offline write");
    await commit(3, "offline");
    await commit(4, "online");
    await commit(5, "online");
    await commit(6, "online");
    assert.equal(writes.length, 7);
    assert.equal(storedStatus, "online", "the remaining replacement tab must restore persisted presence");
    assert.equal(internals.hasConnectedUser("same-user"), true);
    assert.equal(internals.presenceWrites.size, 0);

    disconnect(replacement);
    await flush();
    await commit(7, "offline");
    assert.equal(writes.length, 8);
    assert.equal(storedStatus, "offline", "only closing the last tab leaves the user offline");
    assert.equal(internals.hasConnectedUser("same-user"), false);
    assert.equal(internals.presenceWrites.size, 0);
  });

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

describe("websocket session revalidation", () => {
  test("closes only sockets from a session whose Clerk lookup fails", async () => {
    const requests: string[] = [];
    const hub = new Hub(undefined, undefined, async (sessionId) => {
      requests.push(sessionId);
      if (sessionId === "session-one") throw new Error("Clerk lookup failed");
      return { userId: "same-user", status: "active" };
    });
    const internals = hub as any;
    const firstSessionSocket = socket();
    const secondSessionSocket = socket();
    const otherSessionSocket = socket();
    const firstSessionClient = client("same-user", firstSessionSocket, "session-one");
    const secondSessionClient = client("same-user", secondSessionSocket, "session-one");
    const otherSessionClient = client("same-user", otherSessionSocket, "session-two");

    internals.registerClient(firstSessionClient);
    internals.registerClient(secondSessionClient);
    internals.registerClient(otherSessionClient);

    await hub.revalidateSession("session-one");
    await hub.revalidateSession("session-two");

    assert.deepEqual(requests, ["session-one", "session-two"]);
    assert.deepEqual(firstSessionSocket.closeCalls, [
      { code: 1008, reason: "Session could not be revalidated." },
    ]);
    assert.deepEqual(secondSessionSocket.closeCalls, [
      { code: 1008, reason: "Session could not be revalidated." },
    ]);
    assert.deepEqual(otherSessionSocket.closeCalls, []);
    assert.equal(internals.clients.has(otherSessionClient), true);
    hub.dispose();
  });

  test("shares checks by session and closes only sockets for an inactive session", async () => {
    const requests: string[] = [];
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const hub = new Hub(undefined, undefined, async (sessionId) => {
      requests.push(sessionId);
      if (sessionId === "session-one") await lookupGate;
      return {
        userId: "same-user",
        status: sessionId === "session-one" ? "revoked" : "active",
      };
    });
    const internals = hub as any;
    const firstSessionSocket = socket();
    const secondSessionSocket = socket();
    const otherSessionSocket = socket();
    const firstSessionClient = client("same-user", firstSessionSocket, "session-one");
    const secondSessionClient = client("same-user", secondSessionSocket, "session-one");

    internals.registerClient(firstSessionClient);
    internals.registerClient(secondSessionClient);
    internals.registerClient(client("same-user", otherSessionSocket, "session-two"));

    assert.equal(internals.sessionCheckTimers.size, 2);
    assert.equal(internals.sessionClients.get("session-one").size, 2);

    const firstCheck = hub.revalidateSession("session-one");
    const overlappingCheck = hub.revalidateSession("session-one");
    assert.deepEqual(requests, ["session-one"]);
    releaseLookup();
    await Promise.all([firstCheck, overlappingCheck]);
    await hub.revalidateSession("session-two");

    assert.deepEqual(requests, ["session-one", "session-two"]);
    assert.deepEqual(firstSessionSocket.closeCalls, [
      { code: 1008, reason: "Session is no longer active." },
    ]);
    assert.deepEqual(secondSessionSocket.closeCalls, [
      { code: 1008, reason: "Session is no longer active." },
    ]);
    assert.deepEqual(otherSessionSocket.closeCalls, []);

    internals.unregisterClient(firstSessionClient);
    assert.equal(internals.sessionCheckTimers.has("session-one"), true);
    internals.unregisterClient(secondSessionClient);
    assert.equal(internals.sessionClients.has("session-one"), false);
    assert.equal(internals.sessionCheckTimers.has("session-one"), false);
    assert.equal(internals.sessionCheckTimers.size, 1);
    hub.dispose();
  });
});