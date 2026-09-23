import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
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
  useClerk: () => ({
    signOut: vi.fn(),
    setActive: vi.fn(),
    client: { signIn: { create: vi.fn() }, sessions: [] },
  }),
  useSession: () => ({ session: { id: "session-1", user: { id: "user-1" } } }),
  useUser: () => ({ user: { id: "user-1" } }),
}));

import App, { AdminChannelRoomOrganizer, DocumentCenter, WorkspaceChannelOrganizer, ownerConfirmationPhrase } from "./App";

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

describe("channel category organization", () => {
  it("offers only same-workspace categories and can assign or unassign a channel", async () => {
    const onMove = vi.fn().mockResolvedValue(true);
    const channel = {
      id: 7,
      name: "#team",
      topic: "",
      memberCount: 2,
      communityId: 13,
      communityName: "Workspace 13",
      categoryId: null as number | null,
      createdAt: "2026-09-21T12:00:00.000Z",
    };
    const categories = [
      { id: 31, name: "Project room", description: "", communityId: 13, communityName: "Workspace 13", communityOwnerId: "owner-1" },
      { id: 32, name: "Another workspace", description: "", communityId: 14, communityName: "Workspace 14", communityOwnerId: "owner-2" },
    ];
    const { rerender } = render(<AdminChannelRoomOrganizer channels={[channel]} categories={categories} working={false} onMove={onMove} />);
    fireEvent.change(screen.getByTestId("select-organize-channel"), { target: { value: "7" } });
    const select = screen.getByTestId("select-organize-category") as HTMLSelectElement;
    expect(select.querySelector('option[value="31"]')).not.toBeNull();
    expect(select.querySelector('option[value="32"]')).toBeNull();
    fireEvent.change(select, { target: { value: "31" } });
    fireEvent.click(screen.getByTestId("button-organize-channel"));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(channel, 31));

    rerender(<AdminChannelRoomOrganizer channels={[{ ...channel, categoryId: 31 }]} categories={categories} working={false} onMove={onMove} />);
    fireEvent.click(screen.getByTestId("button-organize-channel"));
    await waitFor(() => expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 7 }), null));
  });

  it("lets a workspace administrator reassign an existing channel without creating one", async () => {
    const onMove = vi.fn().mockResolvedValue(true);
    const detail = {
      community: { id: 13 },
      channels: [{ id: 7, name: "#team", categoryId: null }],
      categories: [{ id: 31, name: "Project room" }],
    } as unknown as ComponentProps<typeof WorkspaceChannelOrganizer>["detail"];
    const { rerender } = render(<WorkspaceChannelOrganizer detail={detail} working={false} onMove={onMove} />);
    fireEvent.change(screen.getByTestId("select-workspace-channel"), { target: { value: "7" } });
    fireEvent.change(screen.getByTestId("select-workspace-category"), { target: { value: "31" } });
    fireEvent.click(screen.getByTestId("button-move-workspace-channel"));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(7, 31));
    rerender(<WorkspaceChannelOrganizer detail={{ ...detail, channels: [{ ...detail.channels[0], categoryId: 31 }] }} working={false} onMove={onMove} />);
    fireEvent.change(screen.getByTestId("select-workspace-category"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("button-move-workspace-channel"));
    await waitFor(() => expect(onMove).toHaveBeenLastCalledWith(7, null));
  });
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
  notificationsFailure = false,
  channelFailureOnce = false,
  dmPaginationFailureOnce = false,
  joinFailureOnce = false,
  createChannelFailureOnce = false,
  fallbackJoined = true,
  uploadFailure = false,
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
  notificationsFailure?: boolean;
  channelFailureOnce?: boolean;
  dmPaginationFailureOnce?: boolean;
  joinFailureOnce?: boolean;
  createChannelFailureOnce?: boolean;
  fallbackJoined?: boolean;
  uploadFailure?: boolean;
}) {
  const deleted = room(1, "#deleted-room", owner ? "user-1" : "owner-1");
  const fallback = {
    ...room(2, "#fallback-room"),
    joined: fallbackJoined,
    accessStatus: fallbackJoined ? "member" as const : "available" as const,
  };
  let channelListCalls = 0;
  let historyCalls = 0;
  let dmPaginationCalls = 0;
  let joinCalls = 0;
  let createChannelCalls = 0;

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
    if (url === "/api/notifications" && method === "GET") {
      return notificationsFailure ? jsonResponse({ error: "notifications unavailable" }, 500) : jsonResponse(notifications);
    }
    if (url.match(/^\/api\/notifications\/\d+\/read$/) && method === "POST") return jsonResponse({ ok: true });
    if (url === "/api/storage/uploads/request-url" && method === "POST") {
      return jsonResponse({
        uploadURL: "https://upload.test/file",
        objectPath: "/objects/uploads/123e4567-e89b-12d3-a456-426614174000",
      });
    }
    if (url === "https://upload.test/file" && method === "PUT") {
      return uploadFailure ? jsonResponse({ error: "upload failed" }, 500) : jsonResponse({});
    }
    if (url === "/api/ws-ticket") return jsonResponse({ ticket: "test-ticket" });
    if (url === "/api/users/search?q=or") return jsonResponse([members()[1]]);
    if (url.startsWith("/api/dm/user-2/messages?before=") && method === "GET") {
      dmPaginationCalls += 1;
      if (dmPaginationFailureOnce && dmPaginationCalls === 1) {
        return jsonResponse({ error: "older messages unavailable" }, 500);
      }
      return jsonResponse({
        messages: [{
          ...message(1, "older recovered message", "dm-older-recovered"),
          channelId: null,
          recipientId: "user-1",
        }],
      });
    }
    if (url === "/api/dm/user-2/messages" && method === "GET") {
      return jsonResponse({
        messages: Array.from({ length: 100 }, (_, index) => ({
          ...message(1, `dm message ${index}`, `dm-message-${String(index).padStart(3, "0")}`),
          channelId: null,
          recipientId: "user-1",
          createdAt: new Date(Date.UTC(2026, 8, 21, 12, 0, index)).toISOString(),
        })),
      });
    }
    if (url === "/api/channels" && method === "GET") {
      channelListCalls += 1;
      if (channelFailureOnce && channelListCalls === 1) return jsonResponse({ error: "channels unavailable" }, 500);
      const initialCall = channelFailureOnce ? 2 : 1;
      return jsonResponse(channelListCalls === initialCall ? [deleted, fallback] : fallbackChannels);
    }
    if (url === "/api/channels" && method === "POST") {
      createChannelCalls += 1;
      if (createChannelFailureOnce && createChannelCalls === 1) {
        return jsonResponse({ error: "channel creation temporarily unavailable" }, 500);
      }
      return jsonResponse({ ...room(3, "#retry-room"), topic: "Retry topic", description: "Retry description" });
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
    if (url === "/api/channels/3/messages" && method === "GET") {
      return jsonResponse({ messages: [] });
    }
    if (url === "/api/channels/3/members" && method === "GET") {
      return jsonResponse(members());
    }
    if (url === "/api/channels/1/messages" && method === "POST") {
      return missingRequest === "send" ? channelNotFound() : jsonResponse(message(1, "sent"));
    }
    if (url === "/api/channels/1/file-messages" && method === "POST") {
      return missingRequest === "send"
        ? channelNotFound()
        : jsonResponse({
          ...message(1, "notes.txt"),
          attachments: [{
            id: 1,
            fileName: "notes.txt",
            contentType: "text/plain",
            fileSize: 10,
            url: "/api/attachments/1",
          }],
        });
    }
    if (url === "/api/channels/1" && method === "PATCH") {
      return missingRequest === "topic" ? channelNotFound() : jsonResponse({ ...deleted, topic: "updated" });
    }
    if (url === "/api/channels/2/join" && method === "POST") {
      joinCalls += 1;
      if (joinFailureOnce && joinCalls === 1) return jsonResponse({ error: "join temporarily unavailable" }, 500);
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

  it("loads chat when notifications are temporarily unavailable", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      notificationsFailure: true,
    });

    expect(screen.getByRole("heading", { name: "#deleted-room" })).toBeTruthy();
    expect(await screen.findByText("stale history")).toBeTruthy();
  });

  it("keeps a sent message visible when notifications are unavailable", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      notificationsFailure: true,
    });

    const editor = screen.getByPlaceholderText("message #deleted-room");
    fireEvent.change(editor, { target: { value: "still delivered" } });
    fireEvent.submit(editor.closest("form")!);

    expect(await screen.findByText("sent")).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("");
  });

  it("shows a retry state when core channel bootstrap fails", async () => {
    installApi({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      channelFailureOnce: true,
    });
    window.history.pushState({}, "", "/chat");
    render(<App />);

    const retry = await screen.findByRole("button", { name: "retry connection" });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByRole("heading", { name: "#deleted-room" })).toBeTruthy());
  });

  it("does not let an older user search overwrite newer results", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
    });
    const baseFetch = vi.mocked(fetch);
    let resolveOlder!: (response: Response) => void;
    let resolveNewer!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    const newerResponse = new Promise<Response>((resolve) => { resolveNewer = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/users/search?q=al") return olderResponse;
      if (url === "/api/users/search?q=alex") return newerResponse;
      return baseFetch(input, init);
    }));

    const search = screen.getByPlaceholderText("find a person");
    fireEvent.change(search, { target: { value: "al" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/users/search?q=al", expect.anything()));
    fireEvent.change(search, { target: { value: "alex" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/users/search?q=alex", expect.anything()));

    await act(async () => {
      resolveNewer(new Response(JSON.stringify([{ ...profile, id: "user-alex", displayName: "Alex" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await newerResponse;
    });
    expect(await screen.findByText("Alex")).toBeTruthy();

    await act(async () => {
      resolveOlder(new Response(JSON.stringify([{ ...profile, id: "user-albert", displayName: "Albert" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await olderResponse;
    });
    expect(screen.getByText("Alex")).toBeTruthy();
    expect(screen.queryByText("Albert")).toBeNull();
  });

  it("keeps DM history visible and retryable when older-message loading fails", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      dmPaginationFailureOnce: true,
    });

    fireEvent.change(screen.getByPlaceholderText("find a person"), { target: { value: "or" } });
    fireEvent.click(await screen.findByRole("button", { name: /Orion/ }));

    const loadOlder = await screen.findByRole("button", { name: "load older messages" });
    expect(screen.getByText("dm message 99")).toBeTruthy();
    fireEvent.click(loadOlder);

    expect(await screen.findByText("Older messages could not be loaded.")).toBeTruthy();
    expect(screen.getByText("dm message 99")).toBeTruthy();
    expect((screen.getByRole("button", { name: "load older messages" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "load older messages" }));
    expect(await screen.findByText("older recovered message")).toBeTruthy();
    expect(screen.queryByText("Older messages could not be loaded.")).toBeNull();
  });

  it("keeps a failed channel join retryable and joins after recovery", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      fallbackJoined: false,
      joinFailureOnce: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /fallback-room/i }));
    expect(await screen.findByText("join temporarily unavailable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "#deleted-room" })).toBeTruthy();
    expect((screen.getByRole("button", { name: /fallback-room/i }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /fallback-room/i }));
    expect(await screen.findByRole("heading", { name: "#fallback-room" })).toBeTruthy();
    expect(screen.queryByText("join temporarily unavailable")).toBeNull();
  });

  it("preserves channel details after creation fails and succeeds on retry", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      createChannelFailureOnce: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
    const nameInput = screen.getByPlaceholderText("#room-name") as HTMLInputElement;
    const topicInput = screen.getByPlaceholderText("What is this room about?") as HTMLInputElement;
    const descriptionInput = screen.getByPlaceholderText("A short description for members") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "#retry-room" } });
    fireEvent.change(topicInput, { target: { value: "Retry topic" } });
    fireEvent.change(descriptionInput, { target: { value: "Retry description" } });
    fireEvent.click(screen.getByLabelText("private room (owner approval)"));
    fireEvent.click(screen.getByRole("button", { name: "create room" }));

    expect(await screen.findByText("channel creation temporarily unavailable")).toBeTruthy();
    expect(nameInput.value).toBe("#retry-room");
    expect(topicInput.value).toBe("Retry topic");
    expect(descriptionInput.value).toBe("Retry description");
    expect((screen.getByLabelText("private room (owner approval)") as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "create room" }));
    expect(await screen.findByRole("heading", { name: "#retry-room" })).toBeTruthy();
    expect(screen.queryByText("channel creation temporarily unavailable")).toBeNull();
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

  it("limits outbound typing frames and clears them after idle or draft removal", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    await waitFor(() => expect(latestWebSocket?.onopen).toBeTruthy());
    latestWebSocket?.onopen?.();
    webSocketFrames = [];
    vi.useFakeTimers();

    const editor = screen.getByPlaceholderText("message #deleted-room");
    fireEvent.change(editor, { target: { value: "h" } });
    fireEvent.change(editor, { target: { value: "he" } });
    fireEvent.change(editor, { target: { value: "hey" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(webSocketFrames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "typing", channelId: 1, active: true },
    ]);

    fireEvent.change(editor, { target: { value: "hey there" } });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(webSocketFrames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "typing", channelId: 1, active: true },
      { type: "typing", channelId: 1, active: false },
    ]);

    fireEvent.change(editor, { target: { value: "a" } });
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.change(editor, { target: { value: "" } });
    expect(webSocketFrames.map((frame) => JSON.parse(frame)).slice(-2)).toEqual([
      { type: "typing", channelId: 1, active: true },
      { type: "typing", channelId: 1, active: false },
    ]);
  });

  it("refreshes the active room after reconnecting and replaces stale messages", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(1, "#deleted-room"), room(2, "#fallback-room")],
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

  it("applies notification read updates received from another session", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      notifications: [{
        id: 8,
        type: "task_updated",
        category: "general",
        body: "Read this from another session",
        createdAt: "2026-09-21T12:00:00.000Z",
        readAt: null,
        actionUrl: null,
      }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText(/Read this from another session/)).toBeTruthy();
    await waitFor(() => expect(latestWebSocket?.onmessage).toBeTruthy());
    latestWebSocket?.onmessage?.({
      data: JSON.stringify({
        type: "notification_read",
        notificationId: 8,
        readAt: "2026-09-21T12:01:00.000Z",
      }),
    } as MessageEvent);

    await waitFor(() => expect(screen.getByText(/· read$/)).toBeTruthy());
  });

  it("does not create a placeholder message when an attachment upload fails", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      uploadFailure: true,
    });

    const file = new File(["attachment"], "notes.txt", { type: "text/plain" });
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
        String(input) === "https://upload.test/file" && init?.method === "PUT",
      )).toBe(true);
    });
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input).includes("/file-messages") && init?.method === "POST",
    )).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input).match(/^\/api\/messages\/[^/]+$/) && init?.method === "DELETE",
    )).toBe(false);
  });
});

describe("frontend route and document error hardening", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a branded 404 page for an unknown route", () => {
    window.history.pushState({}, "", "/does-not-exist");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Nothing here." })).toBeTruthy();
    expect(screen.getByText("404 · route not found")).toBeTruthy();
    expect(screen.queryByText("Real rooms.")).toBeNull();
  });

  it("surfaces document loading failures instead of showing an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ error: "documents unavailable" }, 503)));
    const detail = {
      community: { id: 7 },
      canManage: false,
    } as Parameters<typeof DocumentCenter>[0]["detail"];

    render(<DocumentCenter detail={detail} working={false} setWorking={vi.fn()} setNotice={vi.fn()} setError={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("documents unavailable");
    expect(screen.getByRole("button", { name: "Dismiss error" })).toBeTruthy();
    expect(screen.queryByText("No documents match this search.")).toBeNull();
  });
});

describe("owner confirmation phrases", () => {
  it("uses the exact server phrase for every destructive owner action", () => {
    expect(ownerConfirmationPhrase("remove-member", "Avery Stone", "Northwind")).toBe("REMOVE MEMBER Avery Stone FROM WORKSPACE Northwind");
    expect(ownerConfirmationPhrase("delete-account", "Avery Stone", "Northwind")).toBe("DELETE ACCOUNT Avery Stone FROM WORKSPACE Northwind");
    expect(ownerConfirmationPhrase("delete-channel", "#shipping", "Northwind")).toBe("DELETE CHANNEL #shipping FROM WORKSPACE Northwind");
    expect(ownerConfirmationPhrase("delete-workspace", "Northwind", "Northwind")).toBe("DELETE WORKSPACE Northwind");
  });
});