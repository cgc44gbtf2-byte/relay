import { act, fireEvent, render, screen, waitFor, cleanup, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

import App, { AdminChannelRoomOrganizer, DocumentCenter, ModerationHistoryPanel, OrganizationPanel, WorkspaceChannelOrganizer, allCollectionPages, appendWorkspaceDetailPage, loadAdminOverview, loadAdminScopeOptions, loadCustomRoleCatalog, ownerConfirmationPhrase, pagedApi, workspaceDetailPageQuery } from "./App";

describe("IRC collection pagination", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads every page of a collection, including records beyond the first 100", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(first), { headers: { "X-Has-More": "true", "X-Next-Offset": "100" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 101 }]), { headers: { "X-Has-More": "false" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await pagedApi<{ id: number }>("/channels");
    expect(result).toHaveLength(101);
    expect(result.at(-1)).toEqual({ id: 101 });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/channels", "/api/channels?limit=100&offset=100"]);
  });

  it("rejects a later-page failure rather than showing an incomplete collection", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }]), { headers: { "X-Has-More": "true", "X-Next-Offset": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Next page unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(pagedApi<{ id: number }>("/categories")).rejects.toThrow("Next page unavailable");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/categories", "/api/categories?limit=100&offset=1"]);
  });

  it("follows next cursors for cursor-enabled collections", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }]), { headers: { "X-Next-Cursor": "cursor-two" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }]), { headers: { "X-Next-Cursor": "cursor-three" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 3 }]), { headers: {} }));
    vi.stubGlobal("fetch", fetch);
    await expect(pagedApi<{ id: number }>("/channels", true)).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/channels?limit=100&cursor=start",
      "/api/channels?limit=100&cursor=cursor-two",
      "/api/channels?limit=100&cursor=cursor-three",
    ]);
  });
});

describe("admin and developer collection pagination", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["/developer/releases"])(
    "loads all 101 records from %s",
    async (path) => {
      const fetch = vi.fn((input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        const offset = Number(url.searchParams.get("offset"));
        return jsonResponse(Array.from({ length: Math.max(0, Math.min(100, 101 - offset)) }, (_, index) => ({ id: offset + index + 1 })));
      });
      vi.stubGlobal("fetch", fetch);
      const rows = await allCollectionPages<{ id: number }>(path);
      expect(rows).toHaveLength(101);
      expect(rows.at(-1)?.id).toBe(101);
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        `/api${path}${path.includes("?") ? "&" : "?"}limit=100&offset=0`,
        `/api${path}${path.includes("?") ? "&" : "?"}limit=100&offset=100`,
      ]);
    },
  );

  it.each(["/admin/users?q=page", "/admin/role-assignments"])(
    "loads cursor pages from %s",
    async (path) => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }]), { headers: { "X-Next-Cursor": "next-token" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }]), { headers: {} }));
      vi.stubGlobal("fetch", fetch);
      await expect(allCollectionPages<{ id: number }>(path, true)).resolves.toEqual([{ id: 1 }, { id: 2 }]);
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        `/api${path}${path.includes("?") ? "&" : "?"}limit=100&cursor=start`,
        `/api${path}${path.includes("?") ? "&" : "?"}limit=100&cursor=next-token`,
      ]);
    },
  );

  it("does not accept partial collections when an admin or developer page fails", async () => {
    for (const path of ["/admin/users", "/developer/releases"]) {
      const fetch = vi.fn((input: RequestInfo | URL) =>
        String(input).includes("offset=100")
          ? jsonResponse({ error: "Second page unavailable" }, 503)
          : jsonResponse(Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))));
      vi.stubGlobal("fetch", fetch);
      await expect(allCollectionPages(path)).rejects.toThrow("Second page unavailable");
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("merges independent admin overview collections through their last pages", async () => {
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const channelCursor = url.searchParams.get("channelCursor");
      const categoryCursor = url.searchParams.get("categoryCursor");
      const channelOffset = channelCursor === "start" ? 0 : channelCursor === "channel-next" ? 50 : 100;
      const categoryOffset = categoryCursor === "start" ? 0 : categoryCursor === "category-next" ? 50 : 100;
      return jsonResponse({
        stats: { users: 1 },
        activity: [{ id: 1 }],
        channels: Array.from({ length: Math.max(0, Math.min(50, 101 - channelOffset)) }, (_, index) => ({ id: channelOffset + index + 1 })),
        categories: Array.from({ length: Math.max(0, Math.min(50, 51 - categoryOffset)) }, (_, index) => ({ id: categoryOffset + index + 1 })),
        collectionPagination: {
          channels: { hasMore: channelOffset + 50 <= 101, nextCursor: channelOffset === 0 ? "channel-next" : channelOffset === 50 ? "channel-last" : null },
          categories: { hasMore: categoryOffset + 50 <= 51, nextCursor: categoryOffset === 0 ? "category-next" : null },
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const overview = await loadAdminOverview<{ channels: Array<{ id: number }>; categories: Array<{ id: number }>; activity: Array<{ id: number }>; collectionPagination: { channels: { hasMore: boolean }; categories: { hasMore: boolean } } }>("/admin/overview?activityLimit=1");
    expect(overview.channels).toHaveLength(101);
    expect(overview.categories).toHaveLength(51);
    expect(overview.activity).toEqual([{ id: 1 }]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/admin/overview?activityLimit=1&channelCursor=start&categoryCursor=start",
      "/api/admin/overview?activityLimit=1&channelCursor=channel-next&categoryCursor=category-next",
      "/api/admin/overview?activityLimit=1&channelCursor=channel-last",
    ]);
  });

  it("propagates an overview second-page error", async () => {
    const fetch = vi.fn((input: RequestInfo | URL) =>
      String(input).includes("channelCursor=next")
        ? jsonResponse({ error: "Overview page unavailable" }, 503)
        : jsonResponse({ channels: [{ id: 1 }], categories: [], collectionPagination: { channels: { hasMore: true, nextCursor: "next" }, categories: { hasMore: false, nextCursor: null } } }));
    vi.stubGlobal("fetch", fetch);
    await expect(loadAdminOverview("/admin/overview")).rejects.toThrow("Overview page unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("follows independent scope-option and custom-role cursors", async () => {
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/admin/scope-options") {
        const next = url.searchParams.has("communitiesCursor") && url.searchParams.get("communitiesCursor") !== "start";
        return jsonResponse({
          communities: [{ id: next ? 2 : 1, name: `community-${next ? 2 : 1}` }],
          categories: [{ id: 1, name: "category", communityId: null }],
          channels: [{ id: next ? 2 : 1, name: `channel-${next ? 2 : 1}`, communityId: null, categoryId: null }],
          departments: [{ id: 1, name: "department", communityId: 1 }],
          pagination: {
            communities: { nextCursor: next ? null : "community-next" },
            categories: { nextCursor: null },
            channels: { nextCursor: next ? null : "channel-next" },
            departments: { nextCursor: null },
          },
        });
      }
      const next = url.searchParams.get("cursor") === "role-next";
      return jsonResponse({
        roles: [{ key: next ? "second" : "first", label: "role", description: "", scopeType: "community", permissions: [], isActive: true }],
        permissions: [],
        pagination: { nextCursor: next ? null : "role-next" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const [options, catalog] = await Promise.all([loadAdminScopeOptions(), loadCustomRoleCatalog()]);
    expect(options.communities.map((item) => item.id)).toEqual([1, 2]);
    expect(options.channels.map((item) => item.id)).toEqual([1, 2]);
    expect(options.categories).toHaveLength(1);
    expect(catalog.roles.map((role) => role.key)).toEqual(["first", "second"]);
    const optionUrls = fetch.mock.calls.map(([input]) => new URL(String(input), "http://localhost"))
      .filter((url) => url.pathname === "/api/admin/scope-options");
    expect(optionUrls).toHaveLength(2);
    expect(optionUrls[0].searchParams.get("communitiesCursor")).toBe("start");
    expect(optionUrls[1].searchParams.get("communitiesCursor")).toBe("community-next");
    expect(optionUrls[1].searchParams.get("channelsCursor")).toBe("channel-next");
    expect(optionUrls[1].searchParams.has("categoriesCursor")).toBe(false);
  });
});

describe("workspace detail pagination", () => {
  it("advances independent cursors and preserves finished collection metadata", () => {
    type Detail = Parameters<typeof appendWorkspaceDetailPage>[0];
    const collections = {
      members: [{ id: "one" }], employees: [{ userId: "one" }], teamMemberships: [{ teamId: 1, userId: "one" }],
      channels: [{ id: 2 }], categories: [], assignments: [], invitations: [], tasks: [],
      departments: [], locations: [], teams: [], policies: [], announcements: [{ id: 20 }],
    };
    const pagination = Object.fromEntries(
      ["employees", "invitations", "tasks", "channels", "categories", "assignments", "departments", "locations", "teams", "policies", "announcements"]
        .map((key) => [key, { limit: key === "announcements" ? 20 : 100, offset: 0, hasMore: ["employees", "channels", "announcements"].includes(key), nextCursor: ["employees", "channels", "announcements"].includes(key) ? `${key}-cursor` : null }]),
    ) as Detail["pagination"];
    const current = { ...collections, pagination } as unknown as Detail;
    const query = new URLSearchParams(workspaceDetailPageQuery(current));
    expect(query.get("employeesCursor")).toBe("employees-cursor");
    expect(query.get("channelsCursor")).toBe("channels-cursor");
    expect(query.get("announcementsCursor")).toBe("announcements-cursor");
    expect(query.has("employeesOffset")).toBe(false);
    expect(query.has("announcementsOffset")).toBe(false);
    expect(query.get("announcementsLimit")).toBe("100");
    expect(query.get("tasksLimit")).toBe("1");
    expect(query.get("tasksOffset")).toBe("0");
    const initialQuery = new URLSearchParams(workspaceDetailPageQuery());
    expect(initialQuery.get("employeesCursor")).toBe("start");
    expect(initialQuery.has("employeesOffset")).toBe(false);
    const page = {
      ...collections, members: [{ id: "two" }], employees: [{ userId: "two" }],
      teamMemberships: [{ teamId: 1, userId: "one" }, { teamId: 2, userId: "two" }],
      channels: [{ id: 3 }], announcements: [{ id: 19 }],
      pagination: Object.fromEntries(Object.entries(pagination ?? {}).map(([key, value]) =>
        [key, { ...value, offset: 100, hasMore: false }],
      )) as Detail["pagination"],
    } as unknown as Detail;
    const merged = appendWorkspaceDetailPage(current, page);
    expect(merged.members.map((item) => item.id)).toEqual(["one", "two"]);
    expect(merged.teamMemberships).toHaveLength(2);
    expect(merged.channels.map((item) => item.id)).toEqual([2, 3]);
    expect(merged.announcements.map((item) => item.id)).toEqual([20, 19]);
    expect(merged.pagination?.tasks.offset).toBe(0);
    expect(merged.pagination?.announcements.hasMore).toBe(false);
  });
});

type Channel = {
  id: number;
  name: string;
  topic: string;
  description: string;
  ownerId: string;
  categoryId: number | null;
  communityId: number | null;
  communityName?: string | null;
  isPrivate: boolean;
  isInviteOnly: boolean;
  joined: boolean;
  accessStatus: "member" | "available";
  memberCount: number;
};

let latestWebSocket: {
  url: string;
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
  communityId: null,
  isPrivate: false,
  isInviteOnly: false,
  joined: true,
  accessStatus: "member",
  memberCount: 2,
});

describe("channel category organization", () => {
  afterEach(() => cleanup());

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
      community: { id: 7 },
      canManage: false,
      channels: [{ id: 7, name: "#team", categoryId: null }],
      categories: [{ id: 31, name: "Project room" }],
    } as Parameters<typeof DocumentCenter>[0]["detail"];
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
function channelNotFound(displayMessage = "This channel is no longer available.") {
  return jsonResponse({ error: displayMessage, code: "CHANNEL_NOT_FOUND" }, 404);
}

function channelAccessRequired() {
  return jsonResponse({ error: "The room permissions have changed.", code: "CHANNEL_ACCESS_REQUIRED" }, 403);
}
function installApi({
  missingRequest,
  accessRequiredRequest,
  fallbackChannels,
  missingChannelMessage = "This channel is no longer available.",
  owner = false,
  reconnectedMessages,
  channelMembers,
  dmMessages,
  notifications = [],
  notificationsFailure = false,
  channelFailureOnce = false,
  recoveryChannelFailureOnce = false,
  recoveryChannelsResponse,
  denyHistoryAfterFirst = false,
  dmPaginationFailureOnce = false,
  joinFailureOnce = false,
  deniedJoinAttempts = 0,
  fallbackChannelsAfterDeniedJoin,
  denyFallbackHistoryUntilJoined = false,
  createChannelFailureOnce = false,
  fallbackJoined = true,
  uploadFailure = false,
  categories = [],
  publicSpaces = [],
}: {
  missingRequest: "history" | "members" | "send" | "attachment" | "topic" | "event";
  accessRequiredRequest?: "history" | "members" | "send" | "file";
  fallbackChannels: Channel[];
  missingChannelMessage?: string;
  owner?: boolean;
  reconnectedMessages?: unknown[];
  channelMembers?: () => Promise<Response>;
  dmMessages?: () => unknown[];
  notifications?: Array<{
    id: number;
    type: string;
    category: "general" | "task_assigned" | "task_updated";
    body: string;
    createdAt: string;
    readAt: string | null;
    actionUrl: string | null;
  }>;
  notificationsFailure?: boolean;
  channelFailureOnce?: boolean;
  recoveryChannelFailureOnce?: boolean;
  recoveryChannelsResponse?: Promise<Response>;
  denyHistoryAfterFirst?: boolean;
  dmPaginationFailureOnce?: boolean;
  joinFailureOnce?: boolean;
  deniedJoinAttempts?: number;
  fallbackChannelsAfterDeniedJoin?: Channel[];
  denyFallbackHistoryUntilJoined?: boolean;
  createChannelFailureOnce?: boolean;
  fallbackJoined?: boolean;
  uploadFailure?: boolean;
  categories?: Array<{ id: number; name: string; description: string; ownerId: string; communityId: number | null }>;
  publicSpaces?: Array<{ id: number | null; name: string }>;
}) {
  const deleted = { ...room(1, "#deleted-room", owner ? "user-1" : "owner-1"), canMovePublicSpace: owner };
  const fallback = {
    ...room(2, "#fallback-room"),
    joined: fallbackJoined,
    accessStatus: fallbackJoined ? "member" as const : "available" as const,
  };
  let channelListCalls = 0;
  let historyCalls = 0;
  let dmPaginationCalls = 0;
  let joinCalls = 0;
  let fallbackAccessGranted = fallbackJoined;
  let createChannelCalls = 0;
  let ticketCalls = 0;

  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/me") return jsonResponse(profile);
    if (url === "/api/onboarding") return jsonResponse({
      nextStep: "start",
      ownerCommunity: { id: 1, name: "Test workspace", slug: "test-workspace", onboardingStep: 9, joined: true, canManage: owner },
      communities: [{ id: 1, name: "Test workspace", slug: "test-workspace", onboardingStep: 9, joined: true, canManage: owner }],
    });
    if (url === "/api/categories" || url.startsWith("/api/categories?")) return jsonResponse(categories);
    if ((url === "/api/notifications" || url.startsWith("/api/notifications?")) && method === "GET") {
      return notificationsFailure ? jsonResponse({ error: "notifications unavailable" }, 500) : jsonResponse(notifications);
    }
    if (url.match(/^\/api\/notifications\/\d+\/detail$/) && method === "GET") {
      const notice = notifications.find((item) => url === `/api/notifications/${item.id}/detail`);
      return notice ? jsonResponse({ notification: notice, message: null }) : jsonResponse({ error: "Not found" }, 404);
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
    if (url === "/api/ws-ticket") return jsonResponse({ ticket: `test-ticket-${++ticketCalls}` });
    if (url === "/api/channels/1/public-spaces" && method === "GET") return jsonResponse(publicSpaces);
    if (url === "/api/channels/1/public-space" && method === "PATCH") {
      const communityId = (JSON.parse(String(init?.body)) as { communityId: number | null }).communityId;
      return jsonResponse({
        ...deleted,
        communityId,
        communityName: communityId === null ? "Public network" : publicSpaces.find((space) => space.id === communityId)?.name,
        categoryId: null,
      });
    }
    if (url.startsWith("/api/users/search?q=or")) return jsonResponse([members()[1]]);
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
        messages: dmMessages?.() ?? Array.from({ length: 100 }, (_, index) => ({
          ...message(1, `dm message ${index}`, `dm-message-${String(index).padStart(3, "0")}`),
          channelId: null,
          recipientId: "user-1",
          createdAt: new Date(Date.UTC(2026, 8, 21, 12, 0, index)).toISOString(),
        })),
      });
    }
    if ((url === "/api/channels" || url.startsWith("/api/channels?")) && method === "GET") {
      channelListCalls += 1;
      if (channelFailureOnce && channelListCalls === 1) return jsonResponse({ error: "channels unavailable" }, 500);
      if (recoveryChannelFailureOnce && channelListCalls === 2) return jsonResponse({ error: "Channel list is temporarily unavailable." }, 503);
      if (recoveryChannelsResponse && channelListCalls === 2) return recoveryChannelsResponse;
      const initialCall = channelFailureOnce ? 2 : 1;
      const availableChannels = joinCalls >= 2 && fallbackChannelsAfterDeniedJoin
        ? fallbackChannelsAfterDeniedJoin
        : fallbackChannels;
      return jsonResponse(channelListCalls === initialCall ? [deleted, fallback] : availableChannels);
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
      if (denyHistoryAfterFirst && historyCalls > 1) return channelAccessRequired();
      if (accessRequiredRequest === "history") return channelAccessRequired();
      return missingRequest === "history"
        ? channelNotFound(missingChannelMessage)
        : jsonResponse({ messages: historyCalls > 1 && reconnectedMessages ? reconnectedMessages : [message(1, "stale history")] });
    }
    if (url === "/api/channels/1/members" && method === "GET") {
      if (channelMembers) return channelMembers();
      if (accessRequiredRequest === "members") return channelAccessRequired();
      return missingRequest === "members" ? channelNotFound(missingChannelMessage) : jsonResponse(members(owner ? "owner" : "member"));
    }
    if (url === "/api/channels/2/messages" && method === "GET") {
      if (denyFallbackHistoryUntilJoined && !fallbackAccessGranted) return channelAccessRequired();
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
      if (accessRequiredRequest === "send") return channelAccessRequired();
      return missingRequest === "send" ? channelNotFound(missingChannelMessage) : jsonResponse(message(1, "sent"));
    }
    if (url === "/api/channels/1/file-messages" && method === "POST") {
      if (accessRequiredRequest === "file") return channelAccessRequired();
      return missingRequest === "attachment"
        ? channelNotFound(missingChannelMessage)
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
      return missingRequest === "topic" ? channelNotFound(missingChannelMessage) : jsonResponse({
        ...deleted,
        topic: "updated",
        categoryId: JSON.parse(String(init?.body)).categoryId ?? null,
      });
    }
    if (url === "/api/channels/2/join" && method === "POST") {
      joinCalls += 1;
      if (joinCalls <= deniedJoinAttempts) {
        return jsonResponse({
          error: "You are not allowed to join this room.",
          code: "CHANNEL_ACCESS_REQUIRED",
        }, 403);
      }
      if (joinFailureOnce && joinCalls === 1) return jsonResponse({ error: "join temporarily unavailable" }, 500);
      fallbackAccessGranted = true;
      return jsonResponse({ status: "member" });
    }
    return jsonResponse({});
  }));

  vi.stubGlobal("WebSocket", class {
    static OPEN = 1;
    readyState = 1;
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    send = vi.fn((frame: string) => webSocketFrames.push(frame));
    close = vi.fn();
    constructor(url: string) {
      this.url = url;
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

describe("workspace moderation history", () => {
  beforeEach(() => cleanup());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows saved actor names and loads subsequent pages from the scoped endpoint", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      actorId: index === 0 ? "removed-account" : `actor-${index + 1}`,
      actorDisplayName: index === 0 ? "Saved former moderator" : `Moderator ${index + 1}`,
      targetUserId: null,
      communityId: 44,
      channelId: null,
      action: index === 0 ? "user_banned" : "message_deleted",
      details: index === 0 ? "Removed from this workspace" : null,
      createdAt: "2026-09-20T12:00:00.000Z",
    }));
    const laterPage = [{
      ...firstPage[0],
      id: 51,
      actorId: "current-moderator",
      actorDisplayName: "Current moderator",
      action: "user_unbanned",
      details: null,
    }];
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/communities/44/moderation-logs") {
        return jsonResponse(url.searchParams.get("moderationOffset") === "50" ? laterPage : firstPage);
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetch);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ModerationHistoryPanel communityId={44} />
      </QueryClientProvider>,
    );

    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-toggle-moderation-history"));
    expect((await screen.findByTestId("text-moderation-actor-1")).textContent).toContain("Saved former moderator");
    expect(screen.getByTestId("text-moderation-details-1").textContent).toBe("Removed from this workspace");
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/communities/44/moderation-logs?moderationLimit=50&moderationOffset=0",
    ]);

    fireEvent.click(screen.getByTestId("button-load-more-moderation-history"));
    expect((await screen.findByTestId("text-moderation-action-51")).textContent).toContain("user unbanned");
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/communities/44/moderation-logs?moderationLimit=50&moderationOffset=0",
      "/api/communities/44/moderation-logs?moderationLimit=50&moderationOffset=50",
    ]);
  });
});

describe("community organization polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("keeps the newly created workspace selected in the URL and after remounting", async () => {
    const workspace = (id: number, name: string) => ({
      id, name, description: "", rules: "", services: "", serviceArea: "",
      businessHours: "", contactEmail: "", contactPhone: "", plan: "business",
      memberCount: 1, channelCount: 0, canManage: false, joined: true,
    });
    const oldWorkspace = workspace(71, "Existing business");
    const newWorkspace = workspace(72, "New business");
    let created = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/permissions/me") return jsonResponse({ permissions: [], assignments: [], roles: [], role: "member" });
      if (url === "/api/me") return jsonResponse(profile);
      if (url === "/api/communities" && init?.method === "POST") {
        created = true;
        return jsonResponse(newWorkspace);
      }
      if (url === "/api/communities" || url.startsWith("/api/communities?")) return jsonResponse(created ? [oldWorkspace, newWorkspace] : [oldWorkspace]);
      const match = url.match(/^\/api\/communities\/(71|72)\?/);
      if (match) return jsonResponse({
        community: match[1] === "72" ? newWorkspace : oldWorkspace,
        canManage: false, canManageOrganization: false, isOwner: false,
        canViewModerationLogs: match[1] === "72",
        members: [], employees: [], departments: [], locations: [], teams: [],
        teamMemberships: [], assignments: [], channels: [], categories: [],
        announcements: [], invitations: [], policies: [], documents: [], tasks: [],
      });
      if (/\/dashboard$/.test(url)) return jsonResponse({ stats: {}, tasks: {}, recentActivity: [] });
      if (/\/activity/.test(url)) return jsonResponse({ entries: [], actions: [] });
      if (/\/documents/.test(url)) return jsonResponse({ documents: [], folders: [], pagination: { hasMore: false }, folderPagination: { hasMore: false } });
      return jsonResponse({});
    }));
    window.history.pushState({}, "", "/communities/71");
    const app = render(<App />);
    await screen.findByRole("heading", { name: "Existing business" });
    expect(screen.queryByTestId("section-moderation-history")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "new" }));
    fireEvent.change(screen.getByLabelText("business name"), { target: { value: "New business" } });
    fireEvent.click(screen.getByRole("button", { name: "create business workspace" }));
    await waitFor(() => expect(window.location.pathname).toBe("/communities/72"));
    expect(await screen.findByRole("heading", { name: "New business" })).toBeTruthy();
    expect(screen.getByTestId("section-moderation-history")).toBeTruthy();

    app.unmount();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "New business" })).toBeTruthy();
    expect(window.location.pathname).toBe("/communities/72");
  });

  it("ignores an older workspace list response after navigating to a different workspace", async () => {
    const workspaces = [81, 82].map((id) => ({
      id, name: `Business ${id}`, description: "", rules: "", services: "",
      serviceArea: "", businessHours: "", contactEmail: "", contactPhone: "",
      plan: "business", memberCount: 1, channelCount: 0, joined: true, canManage: false,
    }));
    let listCalls = 0;
    let resolveOlderList!: (response: Response) => void;
    const olderList = new Promise<Response>((resolve) => { resolveOlderList = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/permissions/me") return jsonResponse({ permissions: [], assignments: [], roles: [], role: "member" });
      if (url === "/api/me") return jsonResponse(profile);
      if (url === "/api/communities" || url.startsWith("/api/communities?")) {
        listCalls++;
        return listCalls === 2 ? olderList : jsonResponse(workspaces);
      }
      const match = url.match(/^\/api\/communities\/(81|82)\?/);
      if (match) return jsonResponse({
        community: workspaces.find((item) => item.id === Number(match[1])),
        canManage: false, canManageOrganization: false, isOwner: false,
        members: [], employees: [], departments: [], locations: [], teams: [],
        teamMemberships: [], assignments: [], channels: [], categories: [],
        announcements: [], invitations: [], policies: [], documents: [], tasks: [],
      });
      if (/\/dashboard$/.test(url)) return jsonResponse({ stats: {}, tasks: {}, recentActivity: [] });
      if (/\/activity/.test(url)) return jsonResponse({ entries: [], actions: [] });
      if (/\/documents/.test(url)) return jsonResponse({ documents: [], folders: [], pagination: { hasMore: false }, folderPagination: { hasMore: false } });
      return jsonResponse({});
    }));
    window.history.pushState({}, "", "/communities/81");
    render(<App />);
    await screen.findByRole("heading", { name: "Business 81" });

    fireEvent.click(screen.getByRole("button", { name: /Business 82/ }));
    await waitFor(() => expect(listCalls).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Business 81/ }));
    await waitFor(() => expect(listCalls).toBe(3));
    await act(async () => { resolveOlderList(await jsonResponse(workspaces)); await olderList; });

    expect(window.location.pathname).toBe("/communities/81");
    expect(await screen.findByRole("heading", { name: "Business 81" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Business 82" })).toBeNull();
  });

  it("renders cross-session relationship changes without replacing an unsaved settings draft", async () => {
    const community = {
      id: 41, name: "Polling workspace", description: "Server description", rules: "", services: "",
      serviceArea: "", businessHours: "", contactEmail: "", contactPhone: "", plan: "business",
      memberCount: 3, channelCount: 0,
    };
    const people = [
      { id: "employee-1", username: "alex", displayName: "Alex Employee", status: "online", role: "member" },
      { id: "manager-1", username: "dana", displayName: "Dana Department", status: "online", role: "member" },
      { id: "manager-2", username: "taylor", displayName: "Taylor Team", status: "online", role: "member" },
    ];
    let serverChanged = false;
    const detail = () => {
      const changed = serverChanged;
      return {
        community, canManage: true, canManageOrganization: true, isOwner: false, members: people,
        employees: [
          {
            userId: "employee-1", username: "alex", displayName: "Alex Employee", employeeNumber: "E-1",
            jobTitle: "Engineer", employmentStatus: "active", departmentId: changed ? 11 : null,
            locationId: changed ? 21 : null, managerId: changed ? "manager-1" : null,
            teamIds: changed ? [31] : [], onboardedAt: null, offboardedAt: null, presenceStatus: "online",
          },
          {
            userId: "manager-1", username: "dana", displayName: "Dana Department", employeeNumber: "E-2",
            jobTitle: "Director", employmentStatus: "active", departmentId: null, locationId: null,
            managerId: null, teamIds: [], onboardedAt: null, offboardedAt: null, presenceStatus: "online",
          },
          {
            userId: "manager-2", username: "taylor", displayName: "Taylor Team", employeeNumber: "E-3",
            jobTitle: "Lead", employmentStatus: "active", departmentId: null, locationId: null,
            managerId: null, teamIds: [], onboardedAt: null, offboardedAt: null, presenceStatus: "online",
          },
        ],
        departments: [{ id: 11, name: "Operations", description: "", managerId: changed ? "manager-1" : null, status: "active" }],
        locations: [{ id: 21, name: "North Office", code: "NO", address: "", timezone: "UTC", status: "active" }],
        teams: [{ id: 31, name: "Response Team", description: "", departmentId: changed ? 11 : null, locationId: changed ? 21 : null, managerId: changed ? "manager-2" : null, status: "active" }],
        teamMemberships: changed ? [{ teamId: 31, userId: "employee-1", role: "member", status: "active", joinedAt: "", endedAt: null }] : [],
        assignments: [{ id: 1, userId: "employee-1", role: "member", scopeType: "community", communityId: 41 }],
        channels: [], categories: [], announcements: [], invitations: [], policies: [], documents: [], tasks: [],
        pagination: {
          employees: { limit: 100, offset: 0, hasMore: false },
          invitations: { limit: 100, offset: 0, hasMore: false },
          tasks: { limit: 100, offset: 0, hasMore: false },
          channels: { limit: 100, offset: 0, hasMore: false },
          categories: { limit: 100, offset: 0, hasMore: false },
          assignments: { limit: 100, offset: 0, hasMore: false },
          departments: { limit: 100, offset: 0, hasMore: false },
          locations: { limit: 100, offset: 0, hasMore: false },
          teams: { limit: 100, offset: 0, hasMore: false },
          policies: { limit: 100, offset: 0, hasMore: false },
          teamMemberships: { limit: 100, offset: 0, hasMore: false },
        },
      };
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/permissions/me") return jsonResponse({ permissions: [], assignments: [], roles: [], role: "admin" });
      if (url === "/api/communities" || url.startsWith("/api/communities?")) return jsonResponse([community]);
      if (url === "/api/me") return jsonResponse(profile);
      if (url === "/api/communities/41/dashboard") return jsonResponse({
        stats: { employees: 3, online: 3, channels: 0, openTasks: 0, announcements: 0, pendingRequests: 0 },
        tasks: { open: 0, dueThisWeek: 0, overdue: 0 },
        recentActivity: [],
      });
      if (url.startsWith("/api/communities/41/activity")) return jsonResponse({ entries: [], actions: [] });
      if (url.startsWith("/api/communities/41/documents")) return jsonResponse({
        documents: [], folders: [], pagination: { limit: 100, offset: 0, hasMore: false },
        folderPagination: { limit: 100, offset: 0, hasMore: false },
      });
      if (url.startsWith("/api/communities/41/organization-snapshot?")) return jsonResponse(detail());
      if (url.startsWith("/api/communities/41?")) return jsonResponse(detail());
      return jsonResponse({});
    }));
    window.history.pushState({}, "", "/communities/41");
    render(<App />);

    await screen.findByRole("heading", { name: "departments" });
    const settingsName = screen.getByPlaceholderText("business name") as HTMLInputElement;
    fireEvent.change(settingsName, { target: { value: "Unsaved local workspace name" } });
    expect(screen.getAllByText(/Location: Unassigned · Teams: Unassigned/)).toHaveLength(3);

    serverChanged = true;
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByText(/Location: North Office · Teams: Response Team · Reporting manager: Dana Department · Department manager: Dana Department · Team manager: Taylor Team/)).toBeTruthy();
    expect((screen.getByLabelText("Manager for Operations") as HTMLSelectElement).value).toBe("manager-1");
    expect((screen.getByLabelText("Manager for Response Team") as HTMLSelectElement).value).toBe("manager-2");
    expect(settingsName.value).toBe("Unsaved local workspace name");
  });

  it("does not let a delayed workspace mutation invalidate the newly selected workspace", async () => {
    const workspace = (id: number, name: string) => ({
      id, name, description: `${name} description`, rules: "", services: "", serviceArea: "",
      businessHours: "", contactEmail: "", contactPhone: "", plan: "business", memberCount: 2,
      channelCount: 0, canManage: true, joined: true,
    });
    const workspaceA = workspace(51, "Workspace A");
    const workspaceB = workspace(52, "Workspace B");
    const detail = (community: typeof workspaceA) => ({
      community, canManage: true, canManageOrganization: true, isOwner: false,
      members: [
        { id: "employee-1", username: "alex", displayName: "Alex Employee", status: "online", role: "member" },
        { id: "manager-1", username: "dana", displayName: "Dana Manager", status: "online", role: "member" },
      ],
      employees: [
        {
          userId: "employee-1", username: "alex", displayName: "Alex Employee", employeeNumber: "E-1",
          jobTitle: "Engineer", employmentStatus: "active", departmentId: 11, locationId: null,
          managerId: null, teamIds: [], onboardedAt: null, offboardedAt: null, presenceStatus: "online",
        },
        {
          userId: "manager-1", username: "dana", displayName: "Dana Manager", employeeNumber: "E-2",
          jobTitle: "Manager", employmentStatus: "active", departmentId: null, locationId: null,
          managerId: null, teamIds: [], onboardedAt: null, offboardedAt: null, presenceStatus: "online",
        },
      ],
      departments: [{ id: 11, name: `${community.name} Department`, description: "", managerId: null, status: "active" }],
      locations: [], teams: [], teamMemberships: [],
      assignments: [{ id: community.id, userId: "employee-1", role: "member", scopeType: "community", communityId: community.id }],
      channels: [], categories: [], announcements: [], invitations: [], policies: [], documents: [], tasks: [],
      pagination: Object.fromEntries([
        "employees", "invitations", "tasks", "channels", "categories", "assignments",
        "departments", "locations", "teams", "policies", "teamMemberships",
      ].map((key) => [key, { limit: 100, offset: 0, hasMore: false }])),
    });
    let resolveMutation!: () => void;
    const mutationResponse = new Promise<Response>((resolve) => {
      resolveMutation = () => resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    });
    let resolveWorkspaceB!: () => void;
    const workspaceBResponse = new Promise<Response>((resolve) => {
      resolveWorkspaceB = () => resolve(new Response(JSON.stringify(detail(workspaceB)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    let workspaceADetailCalls = 0;
    let workspaceBDetailCalls = 0;
    let workspaceASnapshotCalls = 0;
    let workspaceBSnapshotCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/permissions/me") return jsonResponse({ permissions: [], assignments: [], roles: [], role: "admin" });
      if (url === "/api/communities" || url.startsWith("/api/communities?")) return jsonResponse([workspaceA, workspaceB]);
      if (url === "/api/me") return jsonResponse(profile);
      if (url === "/api/communities/51/departments/11/manager" && init?.method === "PATCH") return mutationResponse;
      if (url.startsWith("/api/communities/51?")) {
        workspaceADetailCalls += 1;
        return jsonResponse(detail(workspaceA));
      }
      if (url.startsWith("/api/communities/52?")) {
        workspaceBDetailCalls += 1;
        return workspaceBDetailCalls === 1 ? workspaceBResponse : jsonResponse(detail(workspaceB));
      }
      if (url.startsWith("/api/communities/51/organization-snapshot?")) {
        workspaceASnapshotCalls += 1;
        return jsonResponse(detail(workspaceA));
      }
      if (url.startsWith("/api/communities/52/organization-snapshot?")) {
        workspaceBSnapshotCalls += 1;
        return jsonResponse(detail(workspaceB));
      }
      if (/\/api\/communities\/(51|52)\/dashboard$/.test(url)) return jsonResponse({
        stats: { employees: 2, online: 2, channels: 0, openTasks: 0, announcements: 0, pendingRequests: 0 },
        tasks: { open: 0, dueThisWeek: 0, overdue: 0 }, recentActivity: [],
      });
      if (/\/api\/communities\/(51|52)\/activity/.test(url)) return jsonResponse({ entries: [], actions: [] });
      if (/\/api\/communities\/(51|52)\/documents/.test(url)) return jsonResponse({
        documents: [], folders: [], pagination: { limit: 100, offset: 0, hasMore: false },
        folderPagination: { limit: 100, offset: 0, hasMore: false },
      });
      return jsonResponse({});
    }));
    window.history.pushState({}, "", "/communities/51");
    render(<App />);
    await screen.findByRole("heading", { name: "Workspace A" });

    fireEvent.change(screen.getByLabelText("Manager for Workspace A Department"), { target: { value: "manager-1" } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input) === "/api/communities/51/departments/11/manager" && init?.method === "PATCH")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Workspace B/ }));
    await waitFor(() => expect(workspaceBDetailCalls).toBe(1));

    await act(async () => {
      resolveMutation();
      await mutationResponse;
    });
    expect(workspaceADetailCalls).toBe(1);

    await act(async () => {
      resolveWorkspaceB();
      await workspaceBResponse;
    });
    expect(await screen.findByRole("heading", { name: "Workspace B" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Workspace A" })).toBeNull();
    expect(workspaceADetailCalls).toBe(1);

    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(workspaceBSnapshotCalls).toBe(1);
    expect(workspaceASnapshotCalls).toBe(0);
    expect(workspaceBDetailCalls).toBe(1);
    expect(workspaceADetailCalls).toBe(1);
    expect(screen.getByRole("heading", { name: "Workspace B" })).toBeTruthy();
  });
});

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

  it("moves an owned channel into a same-workspace category and back without hiding history", async () => {
    await renderChat({
      missingRequest: "event",
      owner: true,
      fallbackChannels: [room(1, "#deleted-room", "user-1"), room(2, "#fallback-room")],
      categories: [
        { id: 31, name: "project room", description: "", ownerId: "user-1", communityId: null },
        { id: 32, name: "foreign workspace", description: "", ownerId: "user-1", communityId: 2 },
      ],
    });
    await screen.findByText("stale history");
    fireEvent.click(await screen.findByTestId("button-organize-current-channel"));
    const category = screen.getByLabelText("category") as HTMLSelectElement;
    expect(category.querySelector('option[value="31"]')).not.toBeNull();
    expect(category.querySelector('option[value="32"]')).toBeNull();
    fireEvent.change(category, { target: { value: "31" } });
    fireEvent.click(screen.getByRole("button", { name: "save category" }));
    await waitFor(() => expect(within(screen.getByText("project room").parentElement!).getByRole("button", { name: /deleted-room/i })).toBeTruthy());
    expect(screen.getByText("stale history")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/channels/1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ categoryId: 31 }) }));

    fireEvent.click(screen.getByTestId("button-organize-current-channel"));
    fireEvent.change(screen.getByLabelText("category"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "save category" }));
    await waitFor(() => expect(within(screen.getByText("uncategorized").parentElement!).getByRole("button", { name: /deleted-room/i })).toBeTruthy());
    expect(screen.getByText("stale history")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/channels/1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ categoryId: null }) }));
  });

  it("moves a public channel to an owned public space while keeping its history", async () => {
    await renderChat({
      missingRequest: "event",
      owner: true,
      fallbackChannels: [room(1, "#deleted-room", "user-1"), room(2, "#fallback-room")],
      publicSpaces: [{ id: 41, name: "Mira's community" }],
    });
    await screen.findByText("stale history");
    fireEvent.click(screen.getByTestId("button-move-public-space"));
    const select = await screen.findByTestId("select-public-space");
    await waitFor(() => expect((select as HTMLSelectElement).querySelector('option[value="41"]')).not.toBeNull());
    fireEvent.change(select, { target: { value: "41" } });
    fireEvent.click(screen.getByRole("button", { name: "move channel" }));
    await waitFor(() => expect(screen.queryByTestId("select-public-space")).toBeNull());
    expect(fetch).toHaveBeenCalledWith("/api/channels/1/public-space",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ communityId: 41 }) }));
    expect(screen.getByTestId("workspace-indicator").getAttribute("aria-label")).toBe("Current workspace: Mira's community");
    expect(screen.getByText("stale history")).toBeTruthy();
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
      if (url.startsWith("/api/users/search?q=al&") || url === "/api/users/search?q=al") return olderResponse;
      if (url.startsWith("/api/users/search?q=alex&") || url === "/api/users/search?q=alex") return newerResponse;
      return baseFetch(input, init);
    }));

    const search = screen.getByPlaceholderText("find a person");
    fireEvent.change(search, { target: { value: "al" } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith("/api/users/search?q=al&limit=100&cursor=start"))).toBe(true));
    fireEvent.change(search, { target: { value: "alex" } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith("/api/users/search?q=alex&limit=100&cursor=start"))).toBe(true));

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

  it("clears inaccessible room content and retries a failed channel-list recovery", async () => {
    await renderChat({
      missingRequest: "history",
      fallbackChannels: [room(2, "#fallback-room")],
      recoveryChannelFailureOnce: true,
    });

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Channel list is temporarily unavailable.");
    expect(screen.queryByText("stale history")).toBeNull();
    expect(screen.queryByRole("heading", { name: "#deleted-room" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "retry channel refresh" }));

    expect(await screen.findByRole("heading", { name: "#fallback-room" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains when automatic recovery cannot join a public room and lets the user retry it", async () => {
    await renderChat({
      missingRequest: "history",
      fallbackChannels: [{ ...room(2, "#fallback-room"), joined: false, accessStatus: "available" }],
      fallbackJoined: false,
      deniedJoinAttempts: 1,
      denyFallbackHistoryUntilJoined: true,
    });

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not restore #fallback-room: You are not allowed to join this room. Choose another room, or select #fallback-room in the channel list to try joining again.",
    );
    expect(screen.queryByRole("heading", { name: "#fallback-room" })).toBeNull();
    expect(screen.queryByText("stale history")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      String(url) === "/api/channels/2/join" && init?.method === "POST",
    )).toHaveLength(1);

    fireEvent.click(within(screen.getByTestId("recovery-room-picker")).getByRole("button", { name: /fallback-room/i }));
    expect(await screen.findByRole("heading", { name: "#fallback-room" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps room choices available after both automatic recovery and a manual join are denied", async () => {
    await renderChat({
      missingRequest: "history",
      fallbackChannels: [{ ...room(2, "#fallback-room"), joined: false, accessStatus: "available" }],
      fallbackJoined: false,
      deniedJoinAttempts: 2,
      denyFallbackHistoryUntilJoined: true,
      fallbackChannelsAfterDeniedJoin: [
        { ...room(2, "#fallback-room"), joined: false, accessStatus: "available" },
        room(3, "#other-room"),
      ],
    });

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not restore #fallback-room: You are not allowed to join this room. Choose another room, or select #fallback-room in the channel list to try joining again.",
    );
    const roomPicker = screen.getByTestId("recovery-room-picker");
    fireEvent.click(within(roomPicker).getByRole("button", { name: /fallback-room/i }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not join #fallback-room: You are not allowed to join this room. Choose another room, or try again.",
    );
    expect(within(screen.getByTestId("recovery-room-picker")).getByRole("button", { name: /other-room/i })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      String(url) === "/api/channels/2/join" && init?.method === "POST",
    )).toHaveLength(2);

    fireEvent.click(within(screen.getByTestId("recovery-room-picker")).getByRole("button", { name: /other-room/i }));
    expect(await screen.findByRole("heading", { name: "#other-room" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recovers when reconnect discovers access to the active room was revoked", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      denyHistoryAfterFirst: true,
    });
    expect(await screen.findByText("stale history")).toBeTruthy();
    await waitFor(() => expect(latestWebSocket?.onopen).toBeTruthy());
    const firstSocket = latestWebSocket;
    act(() => firstSocket?.onopen?.());

    vi.useFakeTimers();
    act(() => firstSocket?.onclose?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    act(() => latestWebSocket?.onopen?.());
    vi.useRealTimers();

    expect(await screen.findByRole("heading", { name: "#fallback-room" })).toBeTruthy();
    expect(screen.queryByText("stale history")).toBeNull();
  });

  it("does not replace a DM selected while unavailable-room recovery is refreshing", async () => {
    let resolveRecovery!: (response: Response) => void;
    const recoveryChannelsResponse = new Promise<Response>((resolve) => {
      resolveRecovery = resolve;
    });
    await renderChat({
      missingRequest: "history",
      fallbackChannels: [room(2, "#fallback-room")],
      recoveryChannelsResponse,
    });

    fireEvent.change(screen.getByPlaceholderText("find a person"), { target: { value: "or" } });
    fireEvent.click(await screen.findByRole("button", { name: /Orion/ }));
    expect(await screen.findByRole("heading", { name: "@orion" })).toBeTruthy();

    await act(async () => {
      resolveRecovery(await jsonResponse([room(2, "#fallback-room")]));
      await recoveryChannelsResponse;
    });

    expect(screen.getByRole("heading", { name: "@orion" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "#fallback-room" })).toBeNull();
  });

  it("shows an actionable duplicate-username error and preserves the profile draft", async () => {
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
    });
    const baseFetch = vi.mocked(fetch);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/me" && init?.method === "PATCH") {
        return jsonResponse({ error: "Username already exists", code: "USERNAME_TAKEN" }, 409);
      }
      return baseFetch(input, init);
    }));

    fireEvent.click(screen.getByRole("button", { name: /Mira.*@mira/ }));
    const username = screen.getByLabelText("username") as HTMLInputElement;
    const displayName = screen.getByLabelText("display name") as HTMLInputElement;
    fireEvent.change(username, { target: { value: "already-used" } });
    fireEvent.change(displayName, { target: { value: "Mira Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "save profile" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "That username is already taken. Choose another username and try again.",
    );
    expect(username.value).toBe("already-used");
    expect(displayName.value).toBe("Mira Draft");
    expect(screen.getByRole("heading", { name: "Your profile" })).toBeTruthy();
  });

  it.each([
    ["history", "This room was archived by its owner."],
    ["history", "The requested destination has been removed."],
    ["send", "This room was archived by its owner."],
    ["send", "The requested destination has been removed."],
  ] as const)("recovers from a missing-channel %s response with changed wording", async (missingRequest, displayMessage) => {
    await renderChat({
      missingRequest,
      missingChannelMessage: displayMessage,
      fallbackChannels: [room(2, "#fallback-room")],
    });
    if (missingRequest === "send") {
      const editor = screen.getByPlaceholderText("message #deleted-room");
      fireEvent.change(editor, { target: { value: "hello" } });
      fireEvent.submit(editor.closest("form")!);
    }
    await waitFor(() => expect(screen.getByRole("heading", { name: "#fallback-room" })).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("stale history")).toBeNull());
  });

  it("removes a room immediately when another session deletes it", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    await waitFor(() => expect(latestWebSocket?.onmessage).toBeTruthy());
    const deletedRoomSocket = latestWebSocket;
    act(() => deletedRoomSocket?.onopen?.());
    act(() => deletedRoomSocket?.onmessage?.({
      data: JSON.stringify({ type: "channel_removed", channelId: 1 }),
    } as MessageEvent));
    await waitFor(() => expect(screen.getByRole("heading", { name: "#fallback-room" })).toBeTruthy());
    expect(latestWebSocket).toBe(deletedRoomSocket);
    await waitFor(() => {
      const frames = webSocketFrames.map((frame) => JSON.parse(frame) as { type?: string; channelId?: number });
      expect(frames).toContainEqual({ type: "subscribe", channelId: 2 });
    });

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
    expect(webSocketFrames.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "typing")).toEqual([
      { type: "typing", channelId: 1, active: true },
    ]);

    fireEvent.change(editor, { target: { value: "hey there" } });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(webSocketFrames.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "typing")).toEqual([
      { type: "typing", channelId: 1, active: true },
      { type: "typing", channelId: 1, active: false },
    ]);

    fireEvent.change(editor, { target: { value: "a" } });
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.change(editor, { target: { value: "" } });
    expect(webSocketFrames.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "typing").slice(-2)).toEqual([
      { type: "typing", channelId: 1, active: true },
      { type: "typing", channelId: 1, active: false },
    ]);
  });

  it("hides room typing in direct messages and does not recreate a healthy socket on room changes", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    await waitFor(() => expect(latestWebSocket?.onmessage).toBeTruthy());
    const roomSocket = latestWebSocket;
    const typingFrame = { data: JSON.stringify({ type: "typing", channelId: 1, userId: "user-2", active: true }) } as MessageEvent;
    act(() => roomSocket?.onmessage?.(typingFrame));
    expect(screen.getByText("Orion typing…")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("find a person"), { target: { value: "or" } });
    fireEvent.click(await screen.findByRole("button", { name: /Orion/ }));
    expect(await screen.findByRole("heading", { name: "@orion" })).toBeTruthy();
    expect(latestWebSocket).toBe(roomSocket);
    expect(screen.queryByText(/typing…/)).toBeNull();
    act(() => roomSocket?.onmessage?.(typingFrame));
    expect(screen.queryByText(/typing…/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /deleted-room/i }));
    expect(await screen.findByRole("heading", { name: "#deleted-room" })).toBeTruthy();
    expect(latestWebSocket).toBe(roomSocket);
    expect(screen.queryByText(/typing…/)).toBeNull();
    act(() => roomSocket?.onmessage?.(typingFrame));
    expect(screen.getByText("Orion typing…")).toBeTruthy();
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
    vi.useFakeTimers();
    const firstSocket = latestWebSocket;
    act(() => firstSocket?.onclose?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(latestWebSocket).not.toBe(firstSocket);
    act(() => latestWebSocket?.onopen?.());
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("reaction survived")).toBeTruthy();
    expect(screen.getByText("[message deleted]")).toBeTruthy();
    expect(screen.queryByText("stale history")).toBeNull();
    expect(screen.getAllByText("reaction survived")).toHaveLength(1);
    expect(screen.getAllByText("[message deleted]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "👍 2" })).toBeTruthy();
  });

  it("restores members after a presence change was missed while disconnected", async () => {
    let currentMembers = members();
    const channelMembers = vi.fn(() => jsonResponse(currentMembers));
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(1, "#deleted-room"), room(2, "#fallback-room")],
      channelMembers,
    });
    await screen.findByRole("button", { name: /Orion/ });
    await act(async () => { await Promise.resolve(); });
    const callsBefore = channelMembers.mock.calls.length;
    const firstSocket = latestWebSocket;
    vi.useFakeTimers();
    act(() => firstSocket?.onclose?.());
    // No presence frame reaches the client while offline.
    currentMembers = [members()[0], { ...members()[1], id: "user-3", username: "nova", displayName: "Nova" }];
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(latestWebSocket).not.toBe(firstSocket);
    await act(async () => { latestWebSocket?.onopen?.(); });
    expect(channelMembers.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(screen.getByRole("button", { name: /Nova/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Orion/ })).toBeNull();
  });

  it("preserves members when a presence refresh temporarily fails", async () => {
    let fail = false;
    const channelMembers = vi.fn(() => fail
      ? Promise.reject(new TypeError("Network unavailable"))
      : jsonResponse(members()));
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(1, "#deleted-room"), room(2, "#fallback-room")],
      channelMembers,
    });
    await screen.findByRole("button", { name: /Orion/ });
    await act(async () => { await Promise.resolve(); });
    const callsBefore = channelMembers.mock.calls.length;
    fail = true;
    await act(async () => {
      latestWebSocket?.onmessage?.({
        data: JSON.stringify({ type: "presence", channelId: 1, action: "leave", user: members()[1] }),
      } as MessageEvent);
    });
    expect(channelMembers).toHaveBeenCalledTimes(callsBefore + 1);
    expect(screen.getByRole("button", { name: "Message Orion" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "#deleted-room" })).toBeTruthy();
  });

  it("keeps the newest members when two presence refreshes and reconnect resolve in reverse order", async () => {
    const pending: Array<(response: Response) => void> = [];
    let delay = false;
    const channelMembers = vi.fn(() => delay
      ? new Promise<Response>((resolve) => { pending.push(resolve); })
      : jsonResponse(members()));
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(1, "#deleted-room"), room(2, "#fallback-room")],
      channelMembers,
    });
    await screen.findByRole("button", { name: /Orion/ });
    await act(async () => { await Promise.resolve(); });
    delay = true;
    for (const action of ["join", "leave"]) {
      await act(async () => {
        latestWebSocket?.onmessage?.({
          data: JSON.stringify({ type: "presence", channelId: 1, action, user: members()[1] }),
        } as MessageEvent);
      });
    }
    expect(pending).toHaveLength(2);
    const firstSocket = latestWebSocket;
    vi.useFakeTimers();
    act(() => firstSocket?.onclose?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(latestWebSocket).not.toBe(firstSocket);
    await act(async () => { latestWebSocket?.onopen?.(); });
    expect(pending).toHaveLength(3);
    vi.useRealTimers();

    const nova = { ...members()[1], id: "user-3", username: "nova", displayName: "Nova" };
    await act(async () => { pending[2](await jsonResponse([members()[0], nova])); });
    expect(screen.getByRole("button", { name: /Nova/ })).toBeTruthy();
    for (const index of [1, 0]) {
      await act(async () => { pending[index](await jsonResponse(index === 1 ? [members()[0]] : members())); });
      expect(screen.getByRole("button", { name: /Nova/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Orion/ })).toBeNull();
    }

    // A pending presence request must also stay scoped to its original room.
    await act(async () => {
      latestWebSocket?.onmessage?.({
        data: JSON.stringify({ type: "presence", channelId: 1, action: "join", user: nova }),
      } as MessageEvent);
    });
    expect(pending).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /fallback-room/ }));
    await screen.findByRole("heading", { name: "#fallback-room" });
    await screen.findByRole("button", { name: /Orion/ });
    await act(async () => { pending[3](await jsonResponse([nova])); });
    expect(screen.getByRole("button", { name: /Orion/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Nova/ })).toBeNull();
  });

  it("ignores a delayed reconnect member response after switching rooms", async () => {
    let resolveMembers!: (response: Response) => void;
    const delayedMembers = new Promise<Response>((resolve) => { resolveMembers = resolve; });
    let delay = false;
    const channelMembers = vi.fn(() => delay ? delayedMembers : jsonResponse(members()));
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(1, "#deleted-room"), room(2, "#fallback-room")],
      channelMembers,
    });
    await screen.findByRole("button", { name: /Orion/ });
    await act(async () => { await Promise.resolve(); });
    const callsBefore = channelMembers.mock.calls.length;
    vi.useFakeTimers();
    act(() => latestWebSocket?.onclose?.());
    delay = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { latestWebSocket?.onopen?.(); });
    expect(channelMembers.mock.calls.length).toBeGreaterThan(callsBefore);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: /fallback-room/ }));
    await screen.findByRole("heading", { name: "#fallback-room" });
    await screen.findByRole("button", { name: /Orion/ });
    await act(async () => {
      resolveMembers(await jsonResponse([{ ...members()[1], id: "user-3", username: "nova", displayName: "Nova" }]));
    });
    expect(screen.getByRole("button", { name: /Orion/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Nova/ })).toBeNull();
  });

  it("refreshes direct messages after reconnecting without duplicating stale reactions or deletions", async () => {
    const dmMessage = (id: string, body: string) => ({
      ...message(1, body, id),
      channelId: null,
      recipientId: "user-1",
      sender: members()[1],
    });
    let serverMessages: unknown[] = [
      { ...dmMessage("dm-reaction", "reaction before reconnect"), reactions: [{ emoji: "👍", count: 1, reacted: false }] },
      dmMessage("dm-deleted", "message before deletion"),
    ];
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(2, "#fallback-room")],
      dmMessages: () => serverMessages,
    });

    fireEvent.change(screen.getByPlaceholderText("find a person"), { target: { value: "or" } });
    fireEvent.click(await screen.findByRole("button", { name: /Orion/ }));
    expect(await screen.findByText("reaction before reconnect")).toBeTruthy();
    expect(screen.getByText("message before deletion")).toBeTruthy();
    expect(screen.getByRole("button", { name: "👍 1" })).toBeTruthy();
    await waitFor(() => expect(latestWebSocket?.onopen).toBeTruthy());
    const firstSocket = latestWebSocket;
    await act(async () => { firstSocket?.onopen?.(); });

    serverMessages = [
      { ...dmMessage("dm-reaction", "reaction after reconnect"), reactions: [{ emoji: "👍", count: 2, reacted: true }] },
      { ...dmMessage("dm-deleted", "[message deleted]"), kind: "deleted", deletedAt: "2026-09-21T12:01:00.000Z" },
    ];
    vi.useFakeTimers();
    await act(async () => {
      firstSocket?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    vi.useRealTimers();
    const reconnectedSocket = latestWebSocket;
    expect(reconnectedSocket).toBeTruthy();
    expect(reconnectedSocket).not.toBe(firstSocket);
    await act(async () => { reconnectedSocket?.onopen?.(); });

    await waitFor(() => {
      expect(screen.getAllByText("reaction after reconnect")).toHaveLength(1);
      expect(screen.getAllByText("[message deleted]")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "👍 2" })).toBeTruthy();
    });
    expect(screen.queryByText("reaction before reconnect")).toBeNull();
    expect(screen.queryByText("message before deletion")).toBeNull();
    expect(screen.queryByRole("button", { name: "👍 1" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/dm/user-2/messages").length).toBeGreaterThanOrEqual(3);
  });

  it("requests a fresh socket and resubscribes after a connection drops", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const firstSocket = latestWebSocket;
    expect(firstSocket).toBeTruthy();
    act(() => firstSocket?.onopen?.());
    const initialTickets = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/ws-ticket").length;

    vi.useFakeTimers();
    act(() => firstSocket?.onclose?.());
    expect(latestWebSocket).toBe(firstSocket);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const reconnectedSocket = latestWebSocket;
    expect(reconnectedSocket).toBeTruthy();
    expect(reconnectedSocket).not.toBe(firstSocket);
    expect(reconnectedSocket?.url).not.toBe(firstSocket?.url);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/ws-ticket")).toHaveLength(initialTickets + 1);
    webSocketFrames = [];
    act(() => reconnectedSocket?.onopen?.());
    expect(webSocketFrames.map((frame) => JSON.parse(frame))).toEqual(expect.arrayContaining([
      { type: "subscribe", channelId: 1 },
    ]));
  });

  it("bounds repeated failures and cancels retries when chat unmounts", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    vi.useFakeTimers();
    const firstSocket = latestWebSocket;
    act(() => firstSocket?.onclose?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const secondSocket = latestWebSocket;
    act(() => secondSocket?.onclose?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(latestWebSocket).toBe(secondSocket);
    cleanup();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(latestWebSocket).toBe(secondSocket);
  });

  it("cancels the previous room's pending retry when switching rooms", async () => {
    await renderChat({ missingRequest: "event", fallbackChannels: [room(2, "#fallback-room")] });
    vi.useFakeTimers();
    const firstSocket = latestWebSocket;
    act(() => firstSocket?.onclose?.());
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /fallback-room/i }));
    });
    await act(async () => { await Promise.resolve(); });
    const newRoomSocket = latestWebSocket;
    expect(newRoomSocket).not.toBe(firstSocket);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(latestWebSocket).toBe(newRoomSocket);
    act(() => newRoomSocket?.onopen?.());
    expect(webSocketFrames.map((frame) => JSON.parse(frame))).toContainEqual({ type: "subscribe", channelId: 2 });
  });

  it("shows live task lifecycle notifications once across replay, reconnect, and reload and opens the matching task", async () => {
    const notifications: NonNullable<Parameters<typeof installApi>[0]["notifications"]> = [];
    await renderChat({
      missingRequest: "event",
      fallbackChannels: [room(1, "#deleted-room")],
      notifications,
    });
    await waitFor(() => expect(latestWebSocket?.onmessage).toBeTruthy());
    act(() => latestWebSocket?.onopen?.());
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByText("You are all caught up.");
    const events = [
      ["task_assigned", "You were assigned Prepare monthly report"],
      ["task_assigned", "Prepare monthly report was reassigned to you"],
      ["task_updated", "Prepare monthly report is Waiting"],
      ["task_updated", "Prepare monthly report is Completed"],
      ["task_updated", "Prepare monthly report is Cancelled"],
    ].map(([type, body], index) => ({
      id: 101 + index, type, category: type as "task_assigned" | "task_updated", body,
      createdAt: "2026-09-21T12:00:00.000Z", readAt: null,
      actionUrl: "/communities/1?taskId=42",
    }));
    const deliver = () => act(() => {
      for (const notification of events) {
        latestWebSocket?.onmessage?.({ data: JSON.stringify({ type: "notification", notification }) } as MessageEvent);
      }
    });
    // The REST inbox remains empty: these rows must come from the live handler.
    deliver();
    deliver();
    for (const notice of events) {
      expect(screen.getAllByTestId(`button-notification-${notice.id}`)).toHaveLength(1);
      expect(screen.getByTestId(`button-notification-${notice.id}`).textContent).toContain(notice.body);
    }
    notifications.push(...events);
    const firstSocket = latestWebSocket;
    act(() => firstSocket?.onclose?.());
    await waitFor(() => expect(latestWebSocket).not.toBe(firstSocket));
    act(() => latestWebSocket?.onopen?.());
    deliver();
    for (const notice of events) expect(screen.getAllByTestId(`button-notification-${notice.id}`)).toHaveLength(1);

    cleanup();
    render(<App />);
    await screen.findByRole("heading", { name: "#deleted-room" });
    await waitFor(() => expect(latestWebSocket?.onmessage).toBeTruthy());
    act(() => latestWebSocket?.onopen?.());
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    await screen.findByTestId("button-notification-101");
    deliver();
    for (const notice of events) expect(screen.getAllByTestId(`button-notification-${notice.id}`)).toHaveLength(1);

    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const community = { id: 1, name: "Employee workspace", description: "", rules: "", services: "", serviceArea: "", businessHours: "", contactEmail: "", contactPhone: "", plan: "business", memberCount: 1, channelCount: 0 };
    const task = { id: 42, title: "Prepare monthly report", description: "Matching task details", status: "cancelled", priority: "normal", assignedTo: profile.id, comments: [], attachments: [] };
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/permissions/me") return jsonResponse({ permissions: [], assignments: [], roles: [] });
      if (url === "/api/communities" || url.startsWith("/api/communities?")) return jsonResponse([community]);
      if (url.startsWith("/api/communities/1?")) return jsonResponse({
        community, canManage: false, isOwner: false, members: [profile], employees: [],
        channels: [], categories: [], assignments: [], announcements: [], invitations: [],
        departments: [], locations: [], teams: [], policies: [], documents: [], tasks: [task],
      });
       if (url === "/api/communities/1/tasks/42" || url.startsWith("/api/communities/1/tasks/42?")) return jsonResponse(task);
      if (url.startsWith("/api/communities/1/documents")) return jsonResponse({ documents: [], folders: [] });
      return originalFetch(input, init);
    });
    fireEvent.click(screen.getByTestId("button-notification-105"));
    await waitFor(() => expect(screen.getByTestId("text-notification-full-content").textContent).toBe(events[4].body));
    fireEvent.click(screen.getByTestId("button-open-notification-context"));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/communities/1?taskId=42"));
    expect(await screen.findByRole("heading", { name: "Prepare monthly report" })).toBeTruthy();
    expect(screen.getAllByText("Matching task details")).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith("/api/communities/1/tasks/42?"))).toBe(true);
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

    expect(screen.getByTestId("text-notification-full-content").textContent).toBe("Open the workspace task");
    fireEvent.click(screen.getByTestId("button-open-notification-context"));
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

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input) === "https://upload.test/file" && init?.method === "PUT")).toBe(true));
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input) === "/api/channels/1/file-messages" && init?.method === "POST")).toBe(false);
  });

  it("shows the empty-channel state when the room disappears while sharing a file", async () => {
    await renderChat({
      missingRequest: "attachment",
      fallbackChannels: [],
    });

    const file = new File(["attachment"], "notes.txt", { type: "text/plain" });
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("no channels available")).toBeTruthy());
    expect(screen.queryByText("stale history")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) =>
      String(input) === "/api/channels/1/file-messages" && init?.method === "POST")).toBe(true);
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

    const setError = vi.fn();

    render(<DocumentCenter detail={detail} working={false} setWorking={vi.fn()} setNotice={vi.fn()} setError={setError} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "documents unavailable");
    expect(setError).toHaveBeenCalledWith("documents unavailable");
    expect(screen.queryByText("No documents match this search.")).toBeNull();
  });

  it("does not render developer data when either owner-only request is forbidden", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/status") {
        return jsonResponse({ isAdmin: true, profile: { ...profile, role: "admin" } });
      }
      if (url === "/api/developer/settings") {
        return jsonResponse({
          siteName: "Leaked private setting",
          landingEyebrow: "secret",
          landingTitle: "secret",
          landingDescription: "secret",
          networkStatusLabel: "secret",
        });
      }
      if (url.startsWith("/api/developer/releases?")) {
        return jsonResponse({ error: "Developer access denied" }, 403);
      }
      return jsonResponse({});
    }));
    window.history.pushState({}, "", "/developer");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This studio is owner-only." })).toBeTruthy();
    expect(screen.queryByText("Leaked private setting")).toBeNull();
    expect(screen.queryByText("Developer access denied")).toBeNull();
  });
});

describe("admin channel and category deletion permissions", () => {
  const category = {
    id: 31,
    name: "Project rooms",
    description: "",
    communityId: 7,
    communityName: "Team workspace",
    communityOwnerId: "user-1",
  };
  const channel = {
    id: 12,
    name: "#team",
    topic: "",
    memberCount: 2,
    communityId: 7,
    categoryId: 31,
    communityName: "Team workspace",
    createdAt: "2026-09-21T12:00:00.000Z",
  };

  function installAdminApi(ownerId: string) {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/status") return jsonResponse({ isAdmin: true, profile: { ...profile, role: "admin" } });
      if (url.startsWith("/api/admin/overview")) return jsonResponse({
        stats: { users: 1, channels: 1, messages: 0, online: 1, admins: 1 },
        users: [],
        channels: [channel],
        categories: [{ ...category, communityOwnerId: ownerId }],
        recentMessages: [],
        activity: [],
        activityPagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null, nextCursor: null },
      });
      if (url === "/api/admin/health") return jsonResponse({ api: "ok", database: "ok", checkedAt: "2026-09-21T12:00:00.000Z" });
      if (url === "/api/channels/12" && init?.method === "DELETE") return jsonResponse({ cleanupPending: false });
      if (url === "/api/communities/7/categories/31/with-channels" && init?.method === "DELETE") {
        return jsonResponse({ deletedChannelCount: 1, cleanupPending: false });
      }
      return jsonResponse({ error: "Unexpected request" }, 404);
    }));
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("lets the exact workspace owner confirm bulk deletion through the owner-only endpoint", async () => {
    installAdminApi("user-1");
    window.history.pushState({}, "", "/admin");
    render(<App />);
    fireEvent.click(await screen.findByTestId("button-admin-nav-channels"));

    expect(screen.queryByText("workspace owner only")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "delete category + channels" }));
    fireEvent.click(screen.getByRole("button", { name: "delete category and channels" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/communities/7/categories/31/with-channels",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DELETE CATEGORY Project rooms AND CHANNELS FROM WORKSPACE Team workspace" }),
      }),
    ));
  });

  it("shows non-owner administrators the owner-only state while deleting channels through the manager endpoint", async () => {
    installAdminApi("other-owner");
    window.history.pushState({}, "", "/admin");
    render(<App />);
    fireEvent.click(await screen.findByTestId("button-admin-nav-channels"));

    expect(await screen.findByText("workspace owner only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "delete category + channels" })).toBeNull();
    expect(screen.getByRole("button", { name: "delete category only" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "delete channel" }));
    fireEvent.click(screen.getAllByRole("button", { name: "delete channel" }).at(-1)!);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/channels/12",
      expect.objectContaining({ method: "DELETE" }),
    ));
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/communities/7/channels/12")).toBe(false);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/with-channels"))).toBe(false);
  });

  it("opens and focuses the channel named by an activity destination", async () => {
    installAdminApi("user-1");
    window.history.pushState({}, "", "/admin?section=channels&channelId=12");
    render(<App />);

    expect(await screen.findByTestId("activity-target-channel-12")).toBeTruthy();
  });

  it("adds newer activity without losing older pages or duplicating an existing event", async () => {
    const activityItem = (id: string, details: string, targetHref?: string) => ({
      id,
      actorId: "user-1",
      actor: "Manager",
      action: "changed_role",
      targetId: `target-${id}`,
      targetLabel: `Account ${id}`,
      targetHref,
      details,
      createdAt: "2026-09-21T12:00:00.000Z",
    });
    const overview = (
      activity: ReturnType<typeof activityItem>[],
      pagination: {
        hasMore: boolean;
        nextCursor: string | null;
        newestCursor: string | null;
        newerHasMore: boolean;
      },
    ) => ({
      stats: { users: 1, channels: 1, messages: 0, online: 1, admins: 1 },
      users: [],
      channels: [channel],
      categories: [{ ...category, communityOwnerId: "user-1" }],
      recentMessages: [],
      activity,
      activityPagination: {
        limit: 2,
        offset: 0,
        hasMore: pagination.hasMore,
        nextOffset: null,
        nextCursor: pagination.nextCursor,
        newestCursor: pagination.newestCursor,
        newerHasMore: pagination.newerHasMore,
      },
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/notifications") return jsonResponse([]);
      if (url.pathname === "/api/admin/status") {
        return jsonResponse({ isAdmin: true, profile: { ...profile, role: "admin" } });
      }
      if (url.pathname === "/api/admin/overview") {
        if (url.searchParams.has("activityAfterCursor")) {
          expect(url.searchParams.get("activityActor")).toBe("Manager");
          expect(url.searchParams.get("activityAction")).toBe("changed");
          return jsonResponse(overview(
            [activityItem("new", "newly added"), activityItem("latest", "already newest")],
            { hasMore: false, nextCursor: null, newestCursor: "new-head", newerHasMore: true },
          ));
        }
        if (url.searchParams.has("activityCursor")) {
          return jsonResponse(overview(
            [activityItem("oldest", "old page retained")],
            { hasMore: false, nextCursor: null, newestCursor: "old-head", newerHasMore: false },
          ));
        }
        return jsonResponse(overview(
          [
            activityItem("latest", "already newest", "/communities/7?taskId=9"),
            activityItem("middle", "middle page retained", "//outside.example/path"),
          ],
          { hasMore: true, nextCursor: "older-page", newestCursor: "head-cursor", newerHasMore: false },
        ));
      }
      if (url.pathname === "/api/admin/health") {
        return jsonResponse({ api: "operational", database: "operational", checkedAt: "2026-09-21T12:00:00.000Z" });
      }
      return jsonResponse({ error: "Unexpected request" }, 404);
    }));
    window.history.pushState({}, "", "/admin");
    render(<App />);
    fireEvent.click(await screen.findByTestId("button-admin-nav-activity"));
    expect(await screen.findByText("already newest")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Account latest" }).getAttribute("href")).toBe("/communities/7?taskId=9");
    expect(screen.getByText("Account middle").closest("a")).toBeNull();

    fireEvent.change(screen.getByTestId("input-activity-actor"), { target: { value: "Manager" } });
    fireEvent.change(screen.getByTestId("input-activity-action"), { target: { value: "changed" } });
    const loadNewerButton = await screen.findByTestId("button-load-newer-activity");
    fireEvent.click(screen.getByRole("button", { name: "load older activity" }));
    expect(await screen.findByText("old page retained")).toBeTruthy();

    fireEvent.click(loadNewerButton);
    expect(await screen.findByText("newly added")).toBeTruthy();
    expect(screen.getByText("middle page retained")).toBeTruthy();
    expect(screen.getByText("old page retained")).toBeTruthy();
    expect(screen.getAllByText("already newest")).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => {
      const url = new URL(String(input), window.location.origin);
      return url.pathname === "/api/admin/overview"
        && url.searchParams.get("activityAfterCursor") === "head-cursor"
        && url.searchParams.get("activityActor") === "Manager"
        && url.searchParams.get("activityAction") === "changed";
    })).toBe(true);
  });
});

describe("admin activity date filters", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("requests activity with date, actor, and action filters and clears all filters", async () => {
    const overviewRequests: string[] = [];
    const exportRequests: string[] = [];
    const mockUrl = Object.assign(class extends window.URL {}, {
      createObjectURL: vi.fn(() => "blob:admin-activity"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("URL", mockUrl);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/status") {
        return jsonResponse({
          isAdmin: true,
          bootstrapAvailable: false,
          profile: { id: "user-1", username: "alpha", displayName: "Alpha" },
        });
      }
      if (url.startsWith("/api/admin/overview")) {
        overviewRequests.push(url);
        return jsonResponse({
          stats: { users: 1, channels: 0, messages: 0, online: 1, admins: 1 },
          users: [],
          channels: [],
          categories: [],
          recentMessages: [],
          activity: [],
          activityPagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null, nextCursor: null },
        });
      }
      if (url === "/api/admin/health") {
        return jsonResponse({ api: "ok", database: "ok", checkedAt: "2026-09-21T12:00:00.000Z" });
      }
      if (url.startsWith("/api/admin/activity/export")) {
        exportRequests.push(url);
        return Promise.resolve(new Response('"id","actor_id"\r\n"1","user-1"', {
          headers: { "content-type": "text/csv" },
        }));
      }
      return jsonResponse({ error: "Unexpected request" }, 404);
    }));
    window.history.pushState({}, "", "/admin");
    render(<App />);

    fireEvent.click(await screen.findByTestId("button-admin-nav-activity"));
    fireEvent.change(await screen.findByTestId("input-activity-actor"), { target: { value: "Alpha" } });
    fireEvent.change(screen.getByTestId("input-activity-action"), { target: { value: "change" } });
    fireEvent.change(screen.getByTestId("input-activity-start-date"), { target: { value: "2026-04-01" } });
    fireEvent.change(screen.getByTestId("input-activity-end-date"), { target: { value: "2026-04-03" } });

    const filteredPath = "/api/admin/overview?activityActor=Alpha&activityAction=change&activityStartDate=2026-04-01&activityEndDate=2026-04-03&channelCursor=start&categoryCursor=start";
    await waitFor(() => expect(overviewRequests).toContain(filteredPath));

    fireEvent.click(screen.getByTestId("button-export-admin-activity"));
    await waitFor(() => expect(exportRequests).toContain(
      "/api/admin/activity/export?activityActor=Alpha&activityAction=change&activityStartDate=2026-04-01&activityEndDate=2026-04-03",
    ));
    expect(mockUrl.createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Activity history downloaded.")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-clear-activity-filters"));
    await waitFor(() => expect(overviewRequests.some((request) => request.startsWith("/api/admin/overview?"))).toBe(true));
    expect((screen.getByTestId("input-activity-start-date") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("input-activity-end-date") as HTMLInputElement).value).toBe("");
    anchorClick.mockRestore();
  });
});

describe("admin activity availability polling", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("shows matching activity without changing the list until the administrator loads it", async () => {
    const activityItem = (id: string, details: string) => ({
      id,
      actorId: "user-1",
      actor: "Manager",
      action: "changed_role",
      targetId: `target-${id}`,
      targetLabel: `Account ${id}`,
      details,
      createdAt: "2026-09-21T12:00:00.000Z",
    });
    const overview = (activity: ReturnType<typeof activityItem>[], newestCursor: string | null) => ({
      stats: { users: 1, channels: 1, messages: 0, online: 1, admins: 1 },
      users: [],
      channels: [],
      categories: [],
      collectionPagination: {
        channels: { limit: 50, offset: 0, hasMore: false },
        categories: { limit: 50, offset: 0, hasMore: false },
      },
      recentMessages: [],
      activity,
      activityPagination: {
        limit: 20,
        offset: 0,
        hasMore: false,
        nextOffset: null,
        nextCursor: null,
        newestCursor,
        newerHasMore: false,
      },
    });
    const overviewRequests: URL[] = [];
    const checks: URL[] = [];
    let hasNewActivity = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/notifications") return jsonResponse([]);
      if (url.pathname === "/api/admin/status") {
        return jsonResponse({ isAdmin: true, profile: { ...profile, role: "admin" } });
      }
      if (url.pathname === "/api/admin/overview") {
        overviewRequests.push(url);
        if (url.searchParams.has("activityAfterCursor")) {
          return jsonResponse(overview([activityItem("new", "newly arrived event")], "advanced-head"));
        }
        return jsonResponse(overview([activityItem("initial", "initial matching event")], "head"));
      }
      if (url.pathname === "/api/admin/activity/check") {
        checks.push(url);
        return jsonResponse({ hasNewActivity });
      }
      if (url.pathname === "/api/admin/health") {
        return jsonResponse({ api: "operational", database: "operational", checkedAt: "2026-09-21T12:00:00.000Z" });
      }
      return jsonResponse({ error: "Unexpected request" }, 404);
    }));
    window.history.pushState({}, "", "/admin");
    render(<App />);
    fireEvent.click(await screen.findByTestId("button-admin-nav-activity"));
    expect(await screen.findByText("initial matching event")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-activity-actor"), { target: { value: "Manager" } });
    fireEvent.change(screen.getByTestId("input-activity-action"), { target: { value: "changed" } });
    fireEvent.change(screen.getByTestId("input-activity-start-date"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByTestId("input-activity-end-date"), { target: { value: "2026-09-30" } });
    await waitFor(() => expect(overviewRequests.some((url) =>
      url.searchParams.get("activityActor") === "Manager"
      && url.searchParams.get("activityAction") === "changed"
      && url.searchParams.get("activityStartDate") === "2026-09-01"
      && url.searchParams.get("activityEndDate") === "2026-09-30",
    )).toBe(true));

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId("button-admin-nav-overview"));
    fireEvent.click(screen.getByTestId("button-admin-nav-activity"));
    hasNewActivity = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(checks.length).toBeGreaterThan(0);
    expect(checks.at(-1)?.searchParams.get("activityAfterCursor")).toBe("head");
    expect(checks.at(-1)?.searchParams.get("activityActor")).toBe("Manager");
    expect(checks.at(-1)?.searchParams.get("activityAction")).toBe("changed");
    expect(checks.at(-1)?.searchParams.get("activityStartDate")).toBe("2026-09-01");
    expect(checks.at(-1)?.searchParams.get("activityEndDate")).toBe("2026-09-30");
    expect(screen.getByTestId("status-new-admin-activity").textContent).toContain("New matching activity");
    expect(screen.queryByText("newly arrived event")).toBeNull();
    expect(screen.getByText("initial matching event")).toBeTruthy();

    vi.useRealTimers();
    fireEvent.click(screen.getByTestId("button-load-newer-activity"));
    expect(await screen.findByText("newly arrived event")).toBeTruthy();
    expect(screen.getByText("initial matching event")).toBeTruthy();
    expect(screen.queryByTestId("status-new-admin-activity")).toBeNull();
  });
});

describe("manager invitation delivery", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const detail = (invitations: Array<{ id: number; email: string; role: string; status: string; expiresAt: string; createdAt: string; emailDeliveryStatus: string }> = []) => ({
    community: { id: 17, name: "Operations" },
    canManage: true,
    canManageOrganization: false,
    isOwner: false,
    invitations,
    employees: [], members: [], departments: [], locations: [], teams: [],
    teamMemberships: [], assignments: [], channels: [], categories: [],
    announcements: [], policies: [], documents: [], tasks: [],
  }) as unknown as Parameters<typeof OrganizationPanel>[0]["detail"];

  const pending = (emailDeliveryStatus: string) => ({
    id: 42, email: "sam@example.com", role: "employee", status: "pending",
    expiresAt: "2027-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", emailDeliveryStatus,
  });

  it.each([
    { status: "sent", message: "Email accepted by provider, delivery not yet confirmed.", failed: false },
    { status: "failed", message: "Email failed to send; share the private link.", failed: true },
  ] as const)("creates an invitation with $status delivery, exposing the fallback link and the correct feedback", async ({ status, message, failed }) => {
    const fetch = vi.fn(() => jsonResponse({ invitationToken: "created-token", emailDelivery: { status, message } }));
    vi.stubGlobal("fetch", fetch);
    const setError = vi.fn();
    const setNotice = vi.fn();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<OrganizationPanel detail={detail()} working={false} setWorking={vi.fn()} setError={setError} setNotice={setNotice} onRefresh={onRefresh} />);

    fireEvent.change(screen.getByPlaceholderText("employee@company.com"), { target: { value: "sam@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "create invitation" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/api/communities/17/invitations", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "sam@example.com", role: "member", departmentId: null, locationId: null, teamId: null }),
    }));
    expect((screen.getByRole("textbox", { name: "Private invitation link" }) as HTMLInputElement).value)
      .toBe(`${window.location.origin}/accept-invitation?communityId=17&token=created-token`);
    expect((screen.getByPlaceholderText("employee@company.com") as HTMLInputElement).value).toBe("");
    expect(failed ? setError : setNotice).toHaveBeenCalledWith(message);
    expect(failed ? setNotice : setError).not.toHaveBeenCalledWith(message);
  });

  it("uses the rotated resend URL even when email fails and retains it if a later resend request fails", async () => {
    let attempts = 0;
    const fetch = vi.fn(() => {
      attempts++;
      return attempts === 1
        ? jsonResponse({ invitationToken: "rotated-token", emailDelivery: { status: "failed", message: "Delivery rejected; use the new private link." } })
        : jsonResponse({ error: "Resend temporarily unavailable" }, 503);
    });
    vi.stubGlobal("fetch", fetch);
    const setError = vi.fn();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<OrganizationPanel detail={detail([pending("sent")])} working={false} setWorking={vi.fn()} setError={setError} setNotice={vi.fn()} onRefresh={onRefresh} />);
    expect(screen.getByText(/delivery not yet confirmed/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "resend" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/api/communities/17/invitations/42/resend", expect.objectContaining({ method: "POST", body: "{}" }));
    const link = screen.getByRole("textbox", { name: "Private invitation link" }) as HTMLInputElement;
    const rotatedUrl = `${window.location.origin}/accept-invitation?communityId=17&token=rotated-token`;
    expect(link.value).toBe(rotatedUrl);
    expect(setError).toHaveBeenCalledWith("Delivery rejected; use the new private link.");

    rerender(<OrganizationPanel detail={detail([pending("failed")])} working={false} setWorking={vi.fn()} setError={setError} setNotice={vi.fn()} onRefresh={onRefresh} />);
    expect(screen.getByText(/Email rejected or failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "resend" }));
    await waitFor(() => expect(setError).toHaveBeenCalledWith("Resend temporarily unavailable"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox", { name: "Private invitation link" }) as HTMLInputElement).value).toBe(rotatedUrl);
  });
});

describe("onboarding invitation batch delivery", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("shows each saved link and failed-delivery message while continuing to create remaining invitations", async () => {
    const posts: string[] = [];
    let progress = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/onboarding") return jsonResponse({
        nextStep: "invite", ownerCommunity: { id: 17, name: "Operations", slug: "operations", onboardingStep: 2, joined: true, canManage: true },
        communities: [],
      });
      if (url === "/api/community-upgrades/status") return jsonResponse({ subscriptionEndsAt: null, ownedCommunities: [], approvedSlots: 0, usedSlots: 0, pendingRequest: null });
      if (url === "/api/communities/17/invitations" && init?.method === "POST") {
        const { email } = JSON.parse(String(init.body)) as { email: string };
        posts.push(email);
        return jsonResponse({
          invitationToken: `token-${posts.length}`,
          emailDelivery: email === "first@example.com"
            ? { status: "failed", message: "First email failed; share its private link." }
            : { status: "sent", message: "Second email accepted by provider." },
        });
      }
      if (url === "/api/onboarding/17/progress" && init?.method === "POST") {
        progress++;
        return jsonResponse({});
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500);
    }));
    window.history.pushState({}, "", "/onboarding");
    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "email addresses" }), { target: { value: "FIRST@example.com, second@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "create member invitations" }));

    expect(await screen.findByRole("heading", { name: "Your Relay is ready." })).toBeTruthy();
    expect(posts).toEqual(["first@example.com", "second@example.com"]);
    expect(progress).toBe(1);
    expect(screen.getByText("First email failed; share its private link.")).toBeTruthy();
    expect(screen.getByText("Second email accepted by provider.")).toBeTruthy();
    for (const token of ["token-1", "token-2"]) {
      const url = `${window.location.origin}/accept-invitation?communityId=17&token=${token}`;
      expect(screen.getByRole("link", { name: url }).getAttribute("href")).toBe(url);
    }
  });

  it("keeps successfully created links and only unprocessed addresses when a later batch request fails", async () => {
    let progress = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/onboarding") return jsonResponse({
        nextStep: "invite", ownerCommunity: { id: 17, name: "Operations", slug: "operations", onboardingStep: 2, joined: true, canManage: true },
        communities: [],
      });
      if (url === "/api/community-upgrades/status") return jsonResponse({ subscriptionEndsAt: null, ownedCommunities: [], approvedSlots: 0, usedSlots: 0, pendingRequest: null });
      if (url === "/api/communities/17/invitations" && init?.method === "POST") {
        const { email } = JSON.parse(String(init.body)) as { email: string };
        return email === "second@example.com"
          ? jsonResponse({ error: "Second invitation unavailable" }, 503)
          : jsonResponse({ invitationToken: "first-token", emailDelivery: { status: "sent", message: "First email accepted." } });
      }
      if (url === "/api/onboarding/17/progress") progress++;
      return jsonResponse({});
    }));
    window.history.pushState({}, "", "/onboarding");
    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "email addresses" }), {
      target: { value: "first@example.com\nsecond@example.com\nthird@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "create member invitations" }));

    expect(await screen.findByText("Second invitation unavailable")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "email addresses" }) as HTMLTextAreaElement).value).toBe("second@example.com\nthird@example.com");
    const url = `${window.location.origin}/accept-invitation?communityId=17&token=first-token`;
    expect(screen.getByRole("link", { name: url }).getAttribute("href")).toBe(url);
    expect(progress).toBe(0);
    expect(screen.queryByRole("heading", { name: "Your Relay is ready." })).toBeNull();
  });
});
