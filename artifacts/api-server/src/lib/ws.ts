import { WebSocketServer, type WebSocket } from "ws";
import { and, eq } from "drizzle-orm";
import { channelMembersTable, channelsTable, db, usersTable } from "@workspace/db";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { clerkClient } from "@clerk/express";

type Client = { socket: WebSocket; userId: string; channelIds: Set<number> };
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
            (message.type !== "subscribe" && message.type !== "typing") ||
            !Number.isInteger(message.channelId)
          ) {
            return;
          }

          const channelId = Number(message.channelId);
          void db
            .select({ id: channelsTable.id, isPrivate: channelsTable.isPrivate })
            .from(channelsTable)
            .where(eq(channelsTable.id, channelId))
            .then(async ([channel]) => {
              if (!channel) return;
              if (channel.isPrivate) {
                const [member] = await db
                  .select({ userId: channelMembersTable.userId })
                  .from(channelMembersTable)
                  .where(
                    and(
                      eq(channelMembersTable.channelId, channelId),
                      eq(channelMembersTable.userId, client.userId),
                    ),
                  );
                if (!member) return;
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