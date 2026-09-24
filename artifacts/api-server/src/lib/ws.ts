import { WebSocketServer, type WebSocket } from "ws";
import { eq, inArray } from "drizzle-orm";
import { channelsTable, communitiesTable, db, usersTable } from "@workspace/db";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { clerkClient } from "@clerk/express";
import { canReadChannel, channelForRead } from "./channel-access";
import { subscriberPaidThrough } from "./community-subscription";

type Client = {
  socket: WebSocket;
  userId: string;
  sessionId: string;
  channelIds: Set<number>;
  channelGenerations: Map<number, number>;
  typingWindowStartedAt: number;
  typingFrameCount: number;
  lastTypingAt: number;
};
type Ticket = { userId: string; sessionId: string; expiresAt: number };
type ChannelReader = typeof channelForRead;
type ChannelAccessChecker = typeof canReadChannel;
type SessionReader = (sessionId: string) => Promise<{ userId: string; status: string }>;

const TICKET_LIFETIME_MS = 60_000;
const TICKET_CLEANUP_INTERVAL_MS = 60_000;
const MAX_TICKETS_CLEANED_PER_SWEEP = 1_000;
const CHANNEL_LIST_ACCESS_CONCURRENCY = 8;

export class Hub {
  private clients = new Set<Client>();
  private sessionClients = new Map<string, Set<Client>>();
  private sessionCheckTimers = new Map<string, ReturnType<typeof setInterval>>();
  private sessionChecksInFlight = new Set<string>();
  private channelClients = new Map<number, Set<Client>>();
  private tickets = new Map<string, Ticket>();
  private presenceWrites = new Map<string, Promise<void>>();
  private readonly ticketCleanupTimer: ReturnType<typeof setInterval>;
  private readonly subscriptionCheckTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly readChannel: ChannelReader = channelForRead,
    private readonly userCanReadChannel: ChannelAccessChecker = canReadChannel,
    private readonly readSession: SessionReader = (sessionId) =>
      clerkClient.sessions.getSession(sessionId),
  ) {
    this.ticketCleanupTimer = setInterval(
      () => this.cleanupExpiredTickets(),
      TICKET_CLEANUP_INTERVAL_MS,
    );
    // The singleton hub should not keep a process (or a unit test) alive.
    this.ticketCleanupTimer.unref();
    this.subscriptionCheckTimer = setInterval(() => {
      void this.revokeExpiredCommunitySubscriptions().catch(() => undefined);
    }, 60_000);
    this.subscriptionCheckTimer.unref();
  }

  issueTicket(userId: string, sessionId: string): string {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { userId, sessionId, expiresAt: Date.now() + TICKET_LIFETIME_MS });
    return ticket;
  }

  consumeTicket(ticket: string): Ticket | null {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  /**
   * Remove a bounded number of expired, unused tickets.
   *
   * The limit keeps a sweep from doing unbounded work if a client floods the
   * ticket endpoint. Live entries are moved to the end so later entries are
   * eventually inspected instead of being starved by the same live prefix.
   */
  cleanupExpiredTickets(
    now = Date.now(),
    limit = MAX_TICKETS_CLEANED_PER_SWEEP,
  ): number {
    if (limit <= 0 || this.tickets.size === 0) return 0;
    let cleaned = 0;
    let inspected = 0;
    for (const [ticket, entry] of this.tickets) {
      if (inspected >= limit) break;
      inspected++;
      this.tickets.delete(ticket);
      if (entry.expiresAt <= now) {
        cleaned++;
      } else {
        this.tickets.set(ticket, entry);
      }
    }
    return cleaned;
  }

  /**
   * Stop Hub-owned timers. This is primarily useful for controlled shutdown
   * and deterministic tests; the process-wide hub remains active by default.
   */
  dispose(): void {
    clearInterval(this.ticketCleanupTimer);
    clearInterval(this.subscriptionCheckTimer);
    for (const timer of this.sessionCheckTimers.values()) clearInterval(timer);
    this.sessionCheckTimers.clear();
  }

  broadcastChannel(channelId: number, event: unknown, excludedUserId?: string): void {
    for (const client of this.channelClients.get(channelId) ?? []) {
      if (client.userId !== excludedUserId && client.channelIds.has(channelId)) {
        this.send(client.socket, event);
      }
    }
  }

  broadcastUser(userId: string, event: unknown): void {
    for (const client of this.clients) {
      if (client.userId === userId) this.send(client.socket, event);
    }
  }

  async broadcastChannelListChanged(channelId: number): Promise<void> {
    let channel: Awaited<ReturnType<ChannelReader>>;
    try {
      channel = await this.readChannel(channelId);
    } catch {
      return;
    }
    if (!channel) return;

    const clients = [...this.clients];
    const userIds = [...new Set(clients.map((client) => client.userId))];
    const accessByUser = new Map<string, boolean>();
    let nextUserIndex = 0;
    const checkAccess = async (): Promise<void> => {
      while (nextUserIndex < userIds.length) {
        const userId = userIds[nextUserIndex++];
        const allowed = await this.userCanReadChannel(channel, userId).catch(() => false);
        accessByUser.set(userId, allowed);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(CHANNEL_LIST_ACCESS_CONCURRENCY, userIds.length) },
        () => checkAccess(),
      ),
    );
    for (const client of clients) {
      if (this.clients.has(client) && accessByUser.get(client.userId) === true) {
        this.send(client.socket, { type: "channel_list_changed" });
      }
    }
  }

  revokeChannelAccess(channelId: number, userId: string): void {
    for (const client of this.clients) {
      if (client.userId !== userId) continue;
      this.removeChannelSubscription(client, channelId);
    }
  }

  revokeUserChannelAccess(channelIds: readonly number[], userId: string): void {
    for (const channelId of channelIds) this.revokeChannelAccess(channelId, userId);
    this.broadcastUser(userId, { type: "workspace_membership_removed", channelIds: [...channelIds] });
  }

  async revokeExpiredCommunitySubscriptions(ownerId?: string): Promise<void> {
    const subscribedIds = [...this.channelClients.keys()];
    if (!subscribedIds.length) return;
    const rows = await db.select({
      channelId: channelsTable.id,
      ownerId: communitiesTable.ownerId,
      plan: communitiesTable.plan,
    }).from(channelsTable)
      .innerJoin(communitiesTable, eq(channelsTable.communityId, communitiesTable.id))
      .where(inArray(channelsTable.id, subscribedIds));
    const owners = [...new Set(rows.filter((row) => row.plan === "subscriber_community"
      && (!ownerId || row.ownerId === ownerId)).map((row) => row.ownerId))];
    const activeOwners = new Set((await Promise.all(owners.map(async (id) =>
      await subscriberPaidThrough(id) ? id : null))).filter((id): id is string => id !== null));
    for (const row of rows) {
      if (row.plan !== "subscriber_community" || (ownerId && row.ownerId !== ownerId)
        || activeOwners.has(row.ownerId)) continue;
      for (const client of [...this.channelClients.get(row.channelId) ?? []]) {
        this.removeChannelSubscription(client, row.channelId);
        this.send(client.socket, { type: "workspace_membership_removed", channelIds: [row.channelId] });
      }
    }
  }

  disconnectUser(userId: string, reason = "Access revoked."): void {
    for (const client of [...this.clients]) {
      if (client.userId === userId) client.socket.close(1008, reason);
    }
    for (const [ticket, entry] of this.tickets) {
      if (entry.userId === userId) this.tickets.delete(ticket);
    }
  }

  async revalidateSession(sessionId: string): Promise<void> {
    if (
      !this.sessionClients.get(sessionId)?.size ||
      this.sessionChecksInFlight.has(sessionId)
    ) {
      return;
    }

    this.sessionChecksInFlight.add(sessionId);
    try {
      const session = await this.readSession(sessionId);
      for (const client of this.sessionClients.get(sessionId) ?? []) {
        if (
          session.userId !== client.userId ||
          session.status !== "active"
        ) {
          client.socket.close(1008, "Session is no longer active.");
        }
      }
    } catch {
      for (const client of this.sessionClients.get(sessionId) ?? []) {
        client.socket.close(1008, "Session could not be revalidated.");
      }
    } finally {
      this.sessionChecksInFlight.delete(sessionId);
    }
  }

  private registerClient(client: Client): void {
    this.clients.add(client);
    const sessionClients = this.sessionClients.get(client.sessionId) ?? new Set<Client>();
    sessionClients.add(client);
    this.sessionClients.set(client.sessionId, sessionClients);

    if (!this.sessionCheckTimers.has(client.sessionId)) {
      const timer = setInterval(() => void this.revalidateSession(client.sessionId), 60_000);
      this.sessionCheckTimers.set(client.sessionId, timer);
    }
  }

  private unregisterClient(client: Client): void {
    this.clients.delete(client);
    const sessionClients = this.sessionClients.get(client.sessionId);
    sessionClients?.delete(client);
    if (sessionClients?.size) return;

    this.sessionClients.delete(client.sessionId);
    const timer = this.sessionCheckTimers.get(client.sessionId);
    if (timer !== undefined) clearInterval(timer);
    this.sessionCheckTimers.delete(client.sessionId);
  }

  private hasConnectedUser(userId: string): boolean {
    for (const client of this.clients) {
      if (client.userId === userId) return true;
    }
    return false;
  }

  private updatePresence(userId: string): void {
    // Serialize writes for this user: a delayed offline write must not finish
    // after a replacement socket's online write.
    const previous = this.presenceWrites.get(userId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await db
        .update(usersTable)
        .set({ status: this.hasConnectedUser(userId) ? "online" : "offline", lastSeenAt: new Date() })
        .where(eq(usersTable.clerkId, userId));
    });
    this.presenceWrites.set(userId, write);
    void write.catch(() => undefined).finally(() => {
      if (this.presenceWrites.get(userId) === write) this.presenceWrites.delete(userId);
    });
  }

  broadcastChannelRemoved(channelId: number): void {
    const authorizedSubscribers = new Set(this.channelClients.get(channelId) ?? []);
    for (const client of authorizedSubscribers) {
      if (client.channelIds.has(channelId)) {
        this.send(client.socket, { type: "channel_removed", channelId });
      }
    }
    for (const client of this.clients) {
      this.removeChannelSubscription(client, channelId);
    }
    this.channelClients.delete(channelId);
  }

  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname !== "/api/ws") return;
      const ticket = this.consumeTicket(url.searchParams.get("ticket") ?? "");
      if (!ticket) {
        socket.destroy();
        return;
      }
      void this.handleUpgrade(wss, request, socket, head, ticket);
    });
  }

  private async handleUpgrade(
    wss: WebSocketServer,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    ticket: Ticket,
  ): Promise<void> {
    try {
      const session = await clerkClient.sessions.getSession(ticket.sessionId);
      if (
        socket.destroyed ||
        session.userId !== ticket.userId ||
        session.status !== "active"
      ) {
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const client = {
        socket: ws,
        userId: ticket.userId,
        sessionId: ticket.sessionId,
        channelIds: new Set(),
        channelGenerations: new Map(),
        typingWindowStartedAt: Date.now(),
        typingFrameCount: 0,
        lastTypingAt: 0,
      } satisfies Client;
      this.registerClient(client);
      this.updatePresence(ticket.userId);
      ws.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as {
            type?: string;
            channelId?: number;
            active?: boolean;
          };
          if (
            (message.type !== "subscribe" &&
              message.type !== "unsubscribe" &&
              message.type !== "typing") ||
            !Number.isSafeInteger(message.channelId) ||
            Number(message.channelId) <= 0
          ) {
            return;
          }

          const channelId = Number(message.channelId);
          if (message.type === "typing") {
            const now = Date.now();
            if (now - client.typingWindowStartedAt >= 1000) {
              client.typingWindowStartedAt = now;
              client.typingFrameCount = 0;
            }
            if (client.typingFrameCount >= 20 || now - client.lastTypingAt < 75) return;
            client.typingFrameCount += 1;
            client.lastTypingAt = now;
          }
          if (message.type === "unsubscribe") {
            this.removeChannelSubscription(client, channelId);
            return;
          }

          const generation = client.channelGenerations.get(channelId) ?? 0;
          void channelForRead(channelId)
            .then(async (channel) => {
              if (!channel || !(await canReadChannel(channel, client.userId))) return;
              if (
                !this.clients.has(client)
                || (client.channelGenerations.get(channelId) ?? 0) !== generation
              ) {
                return;
              }
              if (message.type === "subscribe") {
                this.addChannelSubscription(client, channelId);
              } else if (client.channelIds.has(channelId)) {
                this.broadcastChannel(
                  channelId,
                  {
                    type: "typing",
                    channelId,
                    userId: client.userId,
                    active: message.active !== false,
                  },
                  client.userId,
                );
              }
            })
            .catch(() => undefined);
        } catch {
          // Ignore malformed client frames.
        }
      });
      ws.on("close", () => {
        this.unregisterClient(client);
        for (const channelId of client.channelIds) {
          this.removeChannelSubscription(client, channelId);
        }
        // Recheck all sockets when the serialized write runs, including any
        // replacement connection that arrived after this close event.
        this.updatePresence(ticket.userId);
      });
      ws.on("error", () => {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
      });
      this.send(ws, { type: "ready" });
    });
  }

  private addChannelSubscription(client: Client, channelId: number): void {
    client.channelIds.add(channelId);
    const subscribers = this.channelClients.get(channelId) ?? new Set<Client>();
    subscribers.add(client);
    this.channelClients.set(channelId, subscribers);
  }

  private removeChannelSubscription(client: Client, channelId: number): void {
    client.channelGenerations.set(
      channelId,
      (client.channelGenerations.get(channelId) ?? 0) + 1,
    );
    client.channelIds.delete(channelId);
    const subscribers = this.channelClients.get(channelId);
    if (!subscribers) return;
    subscribers.delete(client);
    if (subscribers.size === 0) this.channelClients.delete(channelId);
  }

  private send(socket: WebSocket, event: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }
}

export const wsHub = new Hub();