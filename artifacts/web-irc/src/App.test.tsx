import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/react/internal", () => ({
  publishableKeyFromHost: () => "pk_test_recovery",
}));

vi.mock("@clerk/themes", () => ({ shadcn: {} }));

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  Show: ({ children, when }: { children: ReactNode; when: string }) => when === "signed-in" ? children : null,
  SignIn: () => null,
  SignUp: () => null,
  useClerk: () => ({ signOut: vi.fn() }),
  useUser: () => ({ user: { id: "user-1" } }),
}));

import App from "./App";

type Channel = {
  id: number;
  name: string;
  topic: string;
  description: string;
  ownerId: string;
  categoryId: null;
  isPrivate: boolean;
  isInviteOnly: boolean;
  joined: boolean;
  accessStatus: "member";
  memberCount: number;
};

let latestWebSocket: {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send: ReturnType<typeof vi.fn>;
} | null = null;
let webSocketFrames: string[] = [];

const profile = {
  id: "user-1",
  username: "mira",
  displayName: "Mira",
  status: "online",
  role: "member",
};

const room = (id: number, name: string, ownerId = "owner-1"): Channel => ({
  id,
  name,
  topic: `${name} topic`,
  description: `${name} description`,
  ownerId,
  categoryId: null,
  isPrivate: false,
  isInviteOnly: false,
  joined: true,
  accessStatus: "member",
  memberCount: 2,
});

const message = (channelId: number, body: string, id = `message-${channelId}`) => ({
  id,
  channelId,
  body,
  kind: "message",
  createdAt: "2026-09-21T12:00:00.000Z",
  sender: profile,
});

const members = (role = "member") => [
  { ...profile, role },
  {
    id: "user-2",
    username: "orion",
    displayName: "Orion",
    status: "online",
    role: "member",
  },
];

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function channelNotFound() {
  return jsonResponse({ error: "This channel is no longer available.", code: "CHANNEL_NOT_FOUND" }, 404);
}

function installApi({
  missingRequest,
  fallbackChannels,
  owner = false,
  reconnectedMessages,
  notifications = [],
}: {
  missingRequest: "history" | "members" | "send" | "topic" | "event";
  fallbackChannels: Channel[];
  owner?: boolean;
  reconnectedMessages?: unknown[];
  notifications?: Array<{
    id: number;
    type: string;
    category: "general";
    body: string;
    createdAt: string;
    readAt: string | null;
    actionUrl: string | null;
  }>;
  uploadFailure?: boolean;
}) {
  const deleted = room(1, "#deleted-room", owner ? "user-1" : "owner-1");
  const fallback = room(2, "#fallback-room");
  let channelListCalls = 0;
  let historyCalls = 0;

  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/me") return jsonResponse(profile);
    if (url === "/api/onboarding") return jsonResponse({
      nextStep: "start",
      ownerCommunity: { id: 1, name: "Test workspace", slug: "test-workspace", onboardingStep: 9, joined: true, canManage: owner },
      communities: [{ id: 1, name: "Test workspace", slug: "test-workspace", onboardingStep: 9, joined: true, canManage: owner }],
    });
    if (url === "/api/categories") return jsonResponse([]);
    if (url === "/api/notifications" && method === "GET") return jsonResponse(notifications);
    if (url.match(/^\/api\/notifications\/\d+\/read$/) && method === "POST") return jsonResponse({ ok: true });
    if (url === "/api/ws-ticket") return jsonResponse({ ticket: "test-ticket" });
    if (url === "/api/channels" && method === "GET") {
      channelListCalls += 1;
      return jsonResponse(channelListCalls === 1 ? [deleted, fallback] : fallbackChannels);
    }
    if (url === "/api/channels/1/messages" && method === "GET") {
      historyCalls += 1;
      return missingRequest === "history"
        ? channelNotFound()
        : jsonResponse({ messages: historyCalls > 1 && reconnectedMessages ? reconnectedMessages : [message(1, "stale history")] });
    }
    if (url === "/api/channels/1/members" && method === "GET") {
      return missingRequest === "members" ? channelNotFound() : jsonResponse(members(owner ? "owner" : "member"));
    }
    if (url === "/api/channels/2/messages" && method === "GET") {
      return jsonResponse({ messages: [] });
    }
    if (url === "/api/channels/2/members" && method === "GET") {
      return jsonResponse(members());
    }
    if (url === "/api/channels/1/messages" && method === "POST") {
      return missingRequest === "send" ? channelNotFound() : jsonResponse(message(1, "sent"));
    }
    if (url === "/api/channels/1" && method === "PATCH") {
      return missingRequest === "topic" ? channelNotFound() : jsonResponse({ ...deleted, topic: "updated" });
    }
    if (url === "/api/channels/2/join" && method === "POST") {
      return jsonResponse({ status: "member" });
    }
    return jsonResponse({});
  }));

  vi.stubGlobal("WebSocket", class {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    send = vi.fn((frame: string) => webSocketFrames.push(frame));
    close = vi.fn();
    constructor() {
      latestWebSocket = this;
    }
  });
}

async function renderChat(options: Parameters<typeof installApi>[0]) {
  installApi(options);
  window.history.pushState({}, "", "/chat");
  render(<App />);
  await waitFor(() => expect(screen.getByRole("heading", { name: "#deleted-room" })).toBeTruthy());
}

describe("deleted room recovery", () => {
  beforeEach(() => {
    vi.stubGlobal("alert", vi.fn());
    vi.stubGlobal("prompt", vi.fn(() => "new topic"));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    latestWebSocket = null;
    webSocketFrames = [];
    vi.unstubAllGlobals();
  });

  it.each([
    ["history loading", "history"],
    ["member loading", "members"],
    ["message sending", "send"],
    ["topic editing", "topic"],
  ] as const)("refreshes and selects another room after %s reports a missing channel", async (_label, missingRequest) => {
    await renderChat({ missingRequest, fallbackChannels: [room(2, "#fallback-room")] , owner: missingRequest === "topic" });

    if (missingRequest === "send") {
      const editor = screen.getByPlaceholderText("message #deleted-room");
      fireEvent.change(editor, { target: { value: "hello" } });
      fireEvent.submit(editor.closest("form")!);
    } else if (missingRequest === "topic") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Edit channel topic" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Edit channel topic" }));
    }

    await waitFor(() => expect(screen.getByRole("heading", { name: "#fallback-room" })).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("stale history")).toBeNull());
    await waitFor(() => expect(screen.getByText("the room is quiet")).toBeTruthy());
    expect(screen.getByRole("button", { name: /fallback-room/i }).classList.contains("bg-sidebar-accent")).toBe(true);
  });

  it.each([
    ["history loading", "history"],
    ["member loading", "members"],
    ["message sending", "send"],
    ["topic editing", "topic"],
  ] as const)("clears the room and shows the empty state when %s reports the last channel missing", async (_label, missingRequest) => {
    await renderChat({ missingRequest, fallbackChannels: [] , owner: missingRequest === "topic" });

    if (missingRequest === "send") {
      const editor = screen.getByPlaceholderText("message #deleted-room");
      fireEvent.change(editor, { target: { value: "hello" } });
      fireEvent.submit(editor.closest("form")!);
    } else if (missingRequest === "topic") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Edit channel topic" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Edit channel topic" }));
    }

    await waitFor(() => expect(screen.getByText("no channels available")).toBeTruthy());
    await waitFor(() => {
      expect(screen.queryByText("#deleted-room")).toBeNull();
      expect(screen.queryByText("stale history")).toBeNull();
      expect(screen.queryByText("Orion")).toBeNull();
    });
  });

  it("removes a room immediately when another session deletes it", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    await waitFor(() => expect(latestWebSocket?.onmessage).toBeTruthy());
    const deletedRoomSocket = latestWebSocket;

    latestWebSocket?.onmessage?.({
      data: JSON.stringify({ type: "channel_removed", channelId: 1 }),
    } as MessageEvent);

    await waitFor(() => expect(screen.getByRole("heading", { name: "#fallback-room" })).toBeTruthy());
    deletedRoomSocket?.onmessage?.({
      data: JSON.stringify({
        type: "message",
        message: message(1, "late message from deleted room", "late-message"),
      }),
    } as MessageEvent);
    expect(screen.queryByRole("heading", { name: "#deleted-room" })).toBeNull();
    expect(screen.queryByText("late message from deleted room")).toBeNull();
    expect(screen.getByRole("button", { name: /fallback-room/i }).classList.contains("bg-sidebar-accent")).toBe(true);
  });

  it("shows the empty-channel state when a realtime removal deletes the selected room", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [] });
    await waitFor(() => expect(latestWebSocket?.onmessage).toBeTruthy());

    latestWebSocket?.onmessage?.({
      data: JSON.stringify({ type: "channel_removed", channelId: 1 }),
    } as MessageEvent);

    await waitFor(() => expect(screen.getByText("no channels available")).toBeTruthy());
    expect(screen.queryByText("#deleted-room")).toBeNull();
  });

  it("unsubscribes from the previous room and ignores its typing events after switching", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    latestWebSocket?.onopen?.();

    fireEvent.click(screen.getByRole("button", { name: /fallback-room/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "#fallback-room" })).toBeTruthy());
    latestWebSocket?.onopen?.();

    const frames = webSocketFrames.map((frame) => JSON.parse(frame) as { type?: string; channelId?: number });
    expect(frames).toEqual(expect.arrayContaining([
      { type: "unsubscribe", channelId: 1 },
      { type: "subscribe", channelId: 2 },
    ]));

    latestWebSocket?.onmessage?.({
      data: JSON.stringify({ type: "typing", channelId: 1, userId: "user-2", active: true }),
    } as MessageEvent);
    expect(screen.queryByText(/Orion typing/)).toBeNull();
  });

  it("refreshes the active room after reconnecting and replaces stale messages", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      reconnectedMessages: [
        {
          ...message(1, "reaction survived", "reaction-message"),
          reactions: [{ emoji: "👍", count: 2, reacted: true }],
        },
        {
          ...message(1, "[message deleted]", "deleted-message"),
          kind: "deleted",
          deletedAt: "2026-09-21T12:01:00.000Z",
        },
      ],
    });

    await waitFor(() => expect(screen.getByText("stale history")).toBeTruthy());
    latestWebSocket?.onclose?.();
    latestWebSocket?.onopen?.();

    await waitFor(() => {
      expect(screen.getByText("reaction survived")).toBeTruthy();
      expect(screen.getByText("[message deleted]")).toBeTruthy();
    });
    expect(screen.queryByText("stale history")).toBeNull();
    expect(screen.getAllByText("reaction survived")).toHaveLength(1);
    expect(screen.getAllByText("[message deleted]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "👍 2" })).toBeTruthy();
  });

  it("requests a fresh socket and resubscribes after a connection drops", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    const firstSocket = latestWebSocket;
    expect(firstSocket).toBeTruthy();

    vi.useFakeTimers();
    firstSocket?.onclose?.();
    await vi.advanceTimersByTimeAsync(1_000);

    const reconnectedSocket = latestWebSocket;
    expect(reconnectedSocket).toBeTruthy();
    expect(reconnectedSocket).not.toBe(firstSocket);
    reconnectedSocket?.onopen?.();
    expect(webSocketFrames.map((frame) => JSON.parse(frame))).toEqual(expect.arrayContaining([
      { type: "subscribe", channelId: 1 },
    ]));
  });

  it("keeps notification navigation inside the signed-in workspace", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      notifications: [{
        id: 7,
        type: "task_updated",
        category: "general",
        body: "Open the workspace task",
        createdAt: "2026-09-21T12:00:00.000Z",
        readAt: null,
        actionUrl: "/communities/1",
      }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.click(screen.getByRole("button", { name: /Open the workspace task/ }));

    await waitFor(() => expect(window.location.pathname).toBe("/communities/1"));
    expect(screen.queryByText("Open the workspace task")).toBeNull();
  });
});