import { WebSocketServer, type WebSocket } from "ws";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { clerkClient } from "@clerk/express";
import { canReadChannel, channelForRead } from "./channel-access";

type Client = {
  socket: WebSocket;
  userId: string;
  channelIds: Set<number>;
  channelGenerations: Map<number, number>;
};
type Ticket = { userId: string; sessionId: string; expiresAt: number };

class Hub {
  private clients = new Set<Client>();
  private tickets = new Map<string, Ticket>();

  issueTicket(userId: string, sessionId: string): string {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { userId, sessionId, expiresAt: Date.now() + 60_000 });
    return ticket;
  }

  consumeTicket(ticket: string): Ticket | null {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry;
  }

  broadcastChannel(channelId: number, event: unknown, excludedUserId?: string): void {
    for (const client of this.clients) {
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

  revokeChannelAccess(channelId: number, userId: string): void {
    for (const client of this.clients) {
      if (client.userId !== userId) continue;
      client.channelGenerations.set(
        channelId,
        (client.channelGenerations.get(channelId) ?? 0) + 1,
      );
      client.channelIds.delete(channelId);
    }
  }

  broadcastChannelRemoved(channelId: number): void {
    for (const client of this.clients) {
      this.send(client.socket, { type: "channel_removed", channelId });
      client.channelGenerations.set(
        channelId,
        (client.channelGenerations.get(channelId) ?? 0) + 1,
      );
      client.channelIds.delete(channelId);
    }
  }

  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });
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
      const client: Client = {
        socket: ws,
        userId: ticket.userId,
        channelIds: new Set(),
        channelGenerations: new Map(),
      };
      this.clients.add(client);
      void db
        .update(usersTable)
        .set({ status: "online", lastSeenAt: new Date() })
        .where(eq(usersTable.clerkId, ticket.userId));
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
          if (message.type === "unsubscribe") {
            client.channelGenerations.set(
              channelId,
              (client.channelGenerations.get(channelId) ?? 0) + 1,
            );
            client.channelIds.delete(channelId);
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
                client.channelIds.add(channelId);
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
        this.clients.delete(client);
        void db
          .update(usersTable)
          .set({ status: "offline", lastSeenAt: new Date() })
          .where(eq(usersTable.clerkId, ticket.userId));
      });
      this.send(ws, { type: "ready" });
    });
  }

  private send(socket: WebSocket, event: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }
}

export const wsHub = new Hub();