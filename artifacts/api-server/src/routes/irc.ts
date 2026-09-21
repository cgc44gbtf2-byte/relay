import { Router, type IRouter, type Response } from "express";
import {
  GetIrcStateQueryParams,
  GetIrcStateResponse,
  type IrcState,
  JoinIrcChannelBody,
  SendIrcMessageBody,
} from "@workspace/api-zod";

type IrcMessage = {
  id: string;
  channel: string;
  nick: string;
  text: string;
  timestamp: string;
  kind: "message" | "system";
};

type IrcUser = {
  nick: string;
  status: "online" | "away";
  color: string;
};

type Room = {
  topic: string;
  messages: IrcMessage[];
  users: IrcUser[];
  subscribers: Set<Response>;
};

const palette = ["#f5b544", "#55c2a0", "#d77bff", "#65a7ff", "#ff7b72"];
const roomTopics: Record<string, string> = {
  "#lobby": "The front door of the network. Say hello.",
  "#design": "Share references, questions, and works in progress.",
  "#help": "A friendly place for questions and troubleshooting.",
};

function now(): string {
  return new Date().toISOString();
}

function cleanChannel(channel: string): string {
  const trimmed = channel.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function createRoom(channel: string): Room {
  const normalized = cleanChannel(channel);
  const seedUsers: IrcUser[] =
    normalized === "#lobby"
      ? [
          { nick: "mira", status: "online", color: palette[0] },
          { nick: "orion", status: "online", color: palette[1] },
          { nick: "jules", status: "away", color: palette[2] },
          { nick: "sable", status: "online", color: palette[3] },
        ]
      : [{ nick: "mira", status: "online", color: palette[0] }];

  const seedMessages: IrcMessage[] =
    normalized === "#lobby"
      ? [
          {
            id: "lobby-1",
            channel: normalized,
            nick: "mira",
            text: "Welcome to the lobby. The room is open.",
            timestamp: "2026-09-20T15:14:00.000Z",
            kind: "message",
          },
          {
            id: "lobby-2",
            channel: normalized,
            nick: "orion",
            text: "Anyone else catching up on the old net tonight?",
            timestamp: "2026-09-20T15:15:00.000Z",
            kind: "message",
          },
          {
            id: "lobby-3",
            channel: normalized,
            nick: "system",
            text: "You are connected to the local relay.",
            timestamp: "2026-09-20T15:16:00.000Z",
            kind: "system",
          },
        ]
      : [
          {
            id: `${normalized}-welcome`,
            channel: normalized,
            nick: "system",
            text: `You joined ${normalized}.`,
            timestamp: now(),
            kind: "system",
          },
        ];

  return {
    topic:
      roomTopics[normalized] ??
      "A quiet corner of the network. Make it yours.",
    messages: seedMessages,
    users: seedUsers,
    subscribers: new Set<Response>(),
  };
}

const rooms = new Map<string, Room>();

function getRoom(channel: string): { channel: string; room: Room } {
  const normalized = cleanChannel(channel);
  const existing = rooms.get(normalized);
  if (existing) return { channel: normalized, room: existing };

  const room = createRoom(normalized);
  rooms.set(normalized, room);
  return { channel: normalized, room };
}

function snapshot(channel: string, room: Room): IrcState {
  return GetIrcStateResponse.parse({
    channel,
    topic: room.topic,
    messages: room.messages.slice(-100),
    users: room.users,
  });
}

function writeEvent(res: Response, event: IrcMessage | IrcState): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(room: Room, event: IrcMessage | IrcState): void {
  for (const subscriber of room.subscribers) writeEvent(subscriber, event);
}

function upsertUser(room: Room, nick: string): IrcUser {
  const existing = room.users.find(
    (user) => user.nick.toLowerCase() === nick.toLowerCase(),
  );
  if (existing) {
    existing.status = "online";
    return existing;
  }
  const user = {
    nick,
    status: "online" as const,
    color: palette[room.users.length % palette.length],
  };
  room.users.push(user);
  return user;
}

const router: IRouter = Router();

router.get("/irc/state", (req, res): void => {
  const parsed = GetIrcStateQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid IRC state query");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { channel, room } = getRoom(parsed.data.channel);
  res.json(snapshot(channel, room));
});

router.post("/irc/join", (req, res): void => {
  const parsed = JoinIrcChannelBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid IRC join request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { channel, room } = getRoom(parsed.data.channel);
  const user = upsertUser(room, parsed.data.nick);
  const systemMessage: IrcMessage = {
    id: crypto.randomUUID(),
    channel,
    nick: "system",
    text: `${user.nick} joined ${channel}`,
    timestamp: now(),
    kind: "system",
  };
  room.messages.push(systemMessage);
  broadcast(room, systemMessage);
  res.json(snapshot(channel, room));
});

router.post("/irc/messages", (req, res): void => {
  const parsed = SendIrcMessageBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid IRC message");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { channel, room } = getRoom(parsed.data.channel);
  const user = upsertUser(room, parsed.data.nick);
  const message: IrcMessage = {
    id: crypto.randomUUID(),
    channel,
    nick: user.nick,
    text: parsed.data.text.trim(),
    timestamp: now(),
    kind: "message",
  };
  room.messages.push(message);
  broadcast(room, message);
  res.status(201).json(message);
});

router.get("/irc/events", (req, res): void => {
  const parsed = GetIrcStateQueryParams.safeParse(req.query);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid IRC event query");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { room } = getRoom(parsed.data.channel);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  writeEvent(res, snapshot(cleanChannel(parsed.data.channel), room));
  room.subscribers.add(res);

  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    room.subscribers.delete(res);
  });
});

export default router;