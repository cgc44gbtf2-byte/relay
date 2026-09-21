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

const message = (channelId: number, body: string) => ({
  id: `message-${channelId}`,
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
  return jsonResponse({ error: "Channel not found." }, 404);
}

function installApi({
  missingRequest,
  fallbackChannels,
  owner = false,
}: {
  missingRequest: "history" | "members" | "send" | "topic";
  fallbackChannels: Channel[];
  owner?: boolean;
}) {
  const deleted = room(1, "#deleted-room", owner ? "user-1" : "owner-1");
  const fallback = room(2, "#fallback-room");
  let channelListCalls = 0;

  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/me") return jsonResponse(profile);
    if (url === "/api/categories") return jsonResponse([]);
    if (url === "/api/notifications") return jsonResponse([]);
    if (url === "/api/ws-ticket") return jsonResponse({ ticket: "test-ticket" });
    if (url === "/api/channels" && method === "GET") {
      channelListCalls += 1;
      return jsonResponse(channelListCalls === 1 ? [deleted, fallback] : fallbackChannels);
    }
    if (url === "/api/channels/1/messages" && method === "GET") {
      return missingRequest === "history" ? channelNotFound() : jsonResponse({ messages: [message(1, "stale history")] });
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
    send = vi.fn();
    close = vi.fn();
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
    cleanup();
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
});