import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Bell,
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Database,
  Hash,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Radio,
  Save,
  Search,
  Server,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  UserRound,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  ClerkProvider,
  Show,
  SignIn,
  SignUp,
  useClerk,
  useUser,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Route, Router as WouterRouter, Switch, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

type Profile = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  status: string;
  role?: string;
};
type Category = { id: number; name: string; description: string; ownerId: string };
type Channel = {
  id: number;
  name: string;
  topic: string;
  description: string;
  ownerId: string;
  categoryId: number | null;
  category?: Category | null;
  isPrivate: boolean;
  isInviteOnly: boolean;
  joined: boolean;
  accessStatus: "member" | "pending" | "available" | "open";
  memberCount: number;
};
type ChatMessage = {
  id: string;
  channelId?: number | null;
  body: string;
  kind: string;
  createdAt: string;
  sender: Profile | null;
  recipientId?: string | null;
  deletedAt?: string | null;
  attachments?: Array<{ id: number; fileName: string; contentType: string; fileSize: number; url: string }>;
  reactions?: Array<{ emoji: string; count: number; reacted: boolean }>;
};
type Member = Profile & { role: string; mutedUntil?: string | null };
type JoinRequest = { id: number; status: string; createdAt: string; user: Profile };
type Notification = { id: number; type: string; body: string; readAt?: string | null; createdAt: string };

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? "Something went wrong", response.status);
  return data as T;
}

function isMissingChannelError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.message === "Channel not found.";
}

function preferredChannel(channels: Channel[]): Channel | null {
  return channels.find((channel) => channel.joined)
    ?? channels.find((channel) => !channel.isPrivate && channel.accessStatus !== "pending")
    ?? null;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function initials(value: string): string {
  return value.slice(0, 2).toUpperCase();
}

function Avatar({ user, size = "md" }: { user?: Profile | null; size?: "sm" | "md" | "lg" }) {
  const colors = ["#f5b544", "#55c2a0", "#d77bff", "#65a7ff", "#ff7b72"];
  const color = colors[(user?.username.length ?? 0) % colors.length];
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-lg font-mono font-bold text-background ${size === "sm" ? "h-7 w-7 text-[9px]" : size === "lg" ? "h-12 w-12 text-sm" : "h-9 w-9 text-[10px]"}`}
      style={{ backgroundColor: user?.avatarUrl ? undefined : color, backgroundImage: user?.avatarUrl ? `url(${user.avatarUrl})` : undefined, backgroundSize: "cover" }}
    >
      {!user?.avatarUrl && initials(user?.displayName || user?.username || "?")}
    </div>
  );
}

function Landing() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Hash className="h-5 w-5" /></div>
          <div><p className="font-mono font-bold">relay</p><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">internet relay chat</p></div>
        </div>
        <div className="flex gap-2">
          <a className="rounded-lg border border-border px-4 py-2 font-mono text-xs hover:bg-muted" href={`${basePath}/sign-in`}>sign in</a>
          <a className="rounded-lg bg-primary px-4 py-2 font-mono text-xs font-bold text-primary-foreground hover:brightness-105" href={`${basePath}/sign-up`}>create account</a>
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-12 px-6 pb-20 pt-16 lg:grid-cols-[1.1fr_.9fr] lg:items-center">
        <div>
          <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.2em] text-primary">a quieter kind of social</p>
          <h1 className="max-w-3xl font-mono text-4xl font-bold leading-[1.1] sm:text-6xl">Real rooms.<br /><span className="text-secondary-foreground">Real presence.</span></h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">Relay brings the immediacy of IRC to the browser, with public channels, direct messages, profiles, and the tools communities need to stay kind.</p>
          <div className="mt-8 flex flex-wrap gap-3"><a className="rounded-lg bg-primary px-5 py-3 font-mono text-sm font-bold text-primary-foreground" href={`${basePath}/sign-up`}>join the network <Zap className="ml-2 inline h-4 w-4" /></a><span className="flex items-center gap-2 rounded-lg border border-border px-4 py-3 font-mono text-xs text-muted-foreground"><span className="h-2 w-2 rounded-full bg-chart-4" /> live and open</span></div>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3 font-mono text-xs"><span className="text-muted-foreground"># lobby</span><span className="text-chart-4">● 4 voices</span></div>
          <div className="space-y-5 p-5">
            <PreviewMessage name="mira" text="Welcome to the lobby. The room is open." color="#f5b544" />
            <PreviewMessage name="orion" text="Anyone else catching up on the old net tonight?" color="#55c2a0" />
            <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground"><span className="h-px w-8 bg-accent" /> You are connected to the local relay.</div>
          </div>
          <div className="border-t border-border p-4"><div className="rounded-lg border border-input bg-background px-3 py-3 font-mono text-xs text-muted-foreground">message #lobby <span className="float-right rounded bg-primary px-2 py-1 text-primary-foreground">send</span></div></div>
        </div>
      </main>
    </div>
  );
}

function PreviewMessage({ name, text, color }: { name: string; text: string; color: string }) {
  return <div className="flex gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-md font-mono text-[10px] font-bold text-background" style={{ backgroundColor: color }}>{initials(name)}</div><div><div className="font-mono text-xs font-bold" style={{ color }}>{name} <span className="ml-2 text-[10px] font-normal text-muted-foreground">03:14 PM</span></div><p className="mt-1 text-sm text-foreground/85">{text}</p></div></div>;
}

function useRoomData(channelId: number | null, activeDm: Profile | null, onMissingChannel?: (channelId: number) => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const onMissingChannelRef = useRef(onMissingChannel);
  onMissingChannelRef.current = onMissingChannel;

  useEffect(() => {
    setMessages([]);
    setMembers([]);
    if (!channelId && !activeDm) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const promise = activeDm
      ? api<{ messages: ChatMessage[] }>(`/dm/${activeDm.id}/messages`)
      : api<{ messages: ChatMessage[] }>(`/channels/${channelId}/messages`);
    promise.then((data) => {
      if (!cancelled) setMessages(data.messages);
    }).catch((error) => {
      if (cancelled) return;
      setMessages([]);
      if (channelId && !activeDm && isMissingChannelError(error)) onMissingChannelRef.current?.(channelId);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    if (channelId && !activeDm) {
      api<Member[]>(`/channels/${channelId}/members`).then((data) => {
        if (!cancelled) setMembers(data);
      }).catch((error) => {
        if (cancelled) return;
        setMembers([]);
        if (isMissingChannelError(error)) onMissingChannelRef.current?.(channelId);
      });
    }
    return () => { cancelled = true; };
  }, [channelId, activeDm]);
  return { messages, setMessages, members, setMembers, loading };
}

function ChatApp() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [currentChannelId, setCurrentChannelId] = useState<number | null>(null);
  const [activeDm, setActiveDm] = useState<Profile | null>(null);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [userResults, setUserResults] = useState<Profile[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [panel, setPanel] = useState<"notifications" | "profile" | "search" | null>(null);
  const [showMembers, setShowMembers] = useState(true);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelTopic, setNewChannelTopic] = useState("");
  const [newChannelDescription, setNewChannelDescription] = useState("");
  const [newChannelCategoryId, setNewChannelCategoryId] = useState("");
  const [newChannelPrivate, setNewChannelPrivate] = useState(false);
  const [newChannelInviteOnly, setNewChannelInviteOnly] = useState(false);
  const [newChannelPassword, setNewChannelPassword] = useState("");
  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryDescription, setNewCategoryDescription] = useState("");
  const [groupedChannels, setGroupedChannels] = useState(false);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [showRequests, setShowRequests] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [connection, setConnection] = useState("connecting");
  const [channelRefreshError, setChannelRefreshError] = useState("");
  const currentChannelIdRef = useRef<number | null>(currentChannelId);
  const activeDmIdRef = useRef<string | null>(activeDm?.id ?? null);
  const channelRefreshRef = useRef<Promise<Channel[]> | null>(null);
  currentChannelIdRef.current = currentChannelId;
  activeDmIdRef.current = activeDm?.id ?? null;

  const refreshChannels = async (): Promise<Channel[]> => {
    if (channelRefreshRef.current) return channelRefreshRef.current;
    const request = api<Channel[]>("/channels").then((list) => {
      setChannels(list);
      setChannelRefreshError("");
      return list;
    }).finally(() => {
      if (channelRefreshRef.current === request) channelRefreshRef.current = null;
    });
    channelRefreshRef.current = request;
    return request;
  };

  const recoverFromMissingChannel = async (channelId: number) => {
    if (currentChannelIdRef.current !== channelId) return;
    currentChannelIdRef.current = null;
    setCurrentChannelId(null);
    setActiveDm(null);
    setJoinRequests([]);
    setShowRequests(false);
    setTypingUsers({});
    try {
      const list = await refreshChannels();
      if (currentChannelIdRef.current !== null) return;
      const next = preferredChannel(list);
      if (!next) return;
      currentChannelIdRef.current = next.id;
      setCurrentChannelId(next.id);
      if (!next.joined && !next.isPrivate) {
        api<{ status: "member" | "pending" }>(`/channels/${next.id}/join`, { method: "POST", body: "{}" })
          .then((result) => {
            if (result.status === "member") {
              setChannels((items) => items.map((item) => item.id === next.id ? { ...item, joined: true, accessStatus: "member" } : item));
            }
          })
          .catch(() => undefined);
      }
    } catch {
      setChannelRefreshError("Could not refresh the channel list.");
    }
  };

  const room = useRoomData(currentChannelId, activeDm, recoverFromMissingChannel);
  const currentChannel = channels.find((channel) => channel.id === currentChannelId) ?? null;
  const actorRole = room.members.find((member) => member.id === profile?.id)?.role;
  const unread = notifications.filter((notification) => !notification.readAt).length;

  useEffect(() => {
    if (!currentChannel || !["owner", "moderator"].includes(actorRole ?? "")) {
      setJoinRequests([]);
      return;
    }
    api<JoinRequest[]>(`/channels/${currentChannel.id}/join-requests`).then(setJoinRequests).catch(() => setJoinRequests([]));
  }, [currentChannel?.id, actorRole]);

  useEffect(() => {
    Promise.all([api<Profile>("/me"), api<Channel[]>("/channels"), api<Category[]>("/categories"), api<Notification[]>("/notifications")]).then(([me, list, categoryList, notices]) => {
      setProfile(me); setChannels(list); setCategories(categoryList); setNotifications(notices);
      const first = preferredChannel(list);
      if (first) setCurrentChannelId(first.id);
      if (first && !first.joined && !first.isPrivate) api(`/channels/${first.id}/join`, { method: "POST", body: "{}" }).then(() => setChannels((items) => items.map((item) => item.id === first.id ? { ...item, joined: true, accessStatus: "member" } : item)));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ ticket: string }>("/ws-ticket").then(({ ticket }) => {
      if (cancelled) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`);
      socket.onopen = () => { setConnection("live"); setWs(socket); if (currentChannelId) socket.send(JSON.stringify({ type: "subscribe", channelId: currentChannelId })); };
      socket.onclose = () => setConnection("offline");
      socket.onerror = () => setConnection("offline");
      socket.onmessage = (event) => {
        try {
           const data = JSON.parse(event.data) as { type: string; message?: ChatMessage; channel?: Channel; action?: string; user?: Profile; userId?: string; messageId?: string; reactions?: ChatMessage["reactions"] };
          if (data.type === "message" && data.message?.channelId === currentChannelId) room.setMessages((items) => items.some((item) => item.id === data.message!.id) ? items : [...items, data.message!]);
          if (data.type === "dm" && data.message && activeDm && (data.message.sender?.id === activeDm.id || data.message.recipientId === activeDm.id)) room.setMessages((items) => items.some((item) => item.id === data.message!.id) ? items : [...items, data.message!]);
          if (data.type === "channel" && data.channel) setChannels((items) => items.map((item) => item.id === data.channel!.id ? { ...item, ...data.channel } : item));
           if (data.type === "typing" && data.userId && data.userId !== profile?.id) {
             setTypingUsers((items) => ({ ...items, [data.userId!]: Date.now() + 1800 }));
             window.setTimeout(() => setTypingUsers((items) => {
               const next = { ...items };
               if ((next[data.userId!] ?? 0) <= Date.now()) delete next[data.userId!];
               return next;
             }), 1900);
           }
           if (data.type === "message_deleted" && data.messageId) {
             room.setMessages((items) => items.map((item) => item.id === data.messageId ? { ...item, body: "[message deleted]", kind: "deleted", deletedAt: new Date().toISOString() } : item));
           }
           if (data.type === "reaction" && data.messageId && data.reactions) {
             room.setMessages((items) => items.map((item) => item.id === data.messageId ? { ...item, reactions: data.reactions } : item));
           }
          if (data.type === "presence" && currentChannelId) {
            api<Member[]>(`/channels/${currentChannelId}/members`).then(room.setMembers).catch(() => undefined);
            const presenceUser = "user" in data && data.user ? (data.user as Profile).displayName : "Someone";
            room.setMessages((items) => [...items, { id: `presence-${Date.now()}`, body: `${presenceUser} ${data.action === "join" ? "joined" : "left"} the room`, kind: "system", createdAt: new Date().toISOString(), sender: null, channelId: currentChannelId }]);
          }
        } catch { /* ignore malformed frames */ }
      };
    }).catch(() => setConnection("offline"));
    return () => { cancelled = true; };
  }, [currentChannelId, activeDm]);

  useEffect(() => {
    if (ws?.readyState === WebSocket.OPEN && currentChannelId) ws.send(JSON.stringify({ type: "subscribe", channelId: currentChannelId }));
  }, [ws, currentChannelId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (userSearch.trim().length >= 2) api<Profile[]>(`/users/search?q=${encodeURIComponent(userSearch)}`).then(setUserResults).catch(() => setUserResults([]));
      else setUserResults([]);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [userSearch]);

  const visibleChannels = useMemo(() => channels.filter((channel) => channel.name.includes(filter.toLowerCase())), [channels, filter]);
  const channelGroups = useMemo(() => categories
    .map((category) => ({
      category,
      channels: visibleChannels.filter((channel) => channel.categoryId === category.id),
    }))
    .filter((group) => group.channels.length > 0), [categories, visibleChannels]);
  const uncategorizedChannels = useMemo(() => visibleChannels.filter((channel) => channel.categoryId === null), [visibleChannels]);
  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    const channelId = activeDm ? null : currentChannelId;
    const dmId = activeDm?.id ?? null;
    if (!activeDm && channelId === null) return;
    setDraft("");
    try {
      const sent = activeDm ? await api<ChatMessage>(`/dm/${activeDm.id}/messages`, { method: "POST", body: JSON.stringify({ body }) }) : await api<ChatMessage>(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ body }) });
      if (activeDmIdRef.current === dmId && currentChannelIdRef.current === channelId) {
        room.setMessages((items) => items.some((item) => item.id === sent.id) ? items : [...items, sent]);
      }
    } catch (error) {
      if (channelId !== null && isMissingChannelError(error)) {
        setDraft("");
        await recoverFromMissingChannel(channelId);
      } else {
        setDraft(body);
        window.alert(error instanceof Error ? error.message : "Message could not be sent");
      }
    }
  };
  const sendTyping = (value: string) => {
    setDraft(value);
    if (ws?.readyState === WebSocket.OPEN && currentChannelId && !activeDm) {
      ws.send(JSON.stringify({ type: "typing", channelId: currentChannelId, active: Boolean(value.trim()) }));
    }
  };
  const joinChannel = async (channel: Channel) => {
    const result = await api<{ status: "member" | "pending" }>(`/channels/${channel.id}/join`, { method: "POST", body: "{}" });
    if (result.status === "pending") {
      setChannels((items) => items.map((item) => item.id === channel.id ? { ...item, accessStatus: "pending" } : item));
      window.alert("Join request sent. The channel owner will review it.");
      return;
    }
    setChannels((items) => items.map((item) => item.id === channel.id ? { ...item, joined: true, accessStatus: "member" } : item));
    setCurrentChannelId(channel.id); setActiveDm(null);
  };
  const createChannel = async (event: FormEvent) => {
    event.preventDefault();
    const created = await api<Channel>("/channels", { method: "POST", body: JSON.stringify({
      name: newChannelName,
      topic: newChannelTopic,
      description: newChannelDescription,
      categoryId: newChannelCategoryId || null,
      isPrivate: newChannelPrivate,
      isInviteOnly: newChannelInviteOnly,
      password: newChannelPassword || undefined,
    }) });
    setChannels((items) => [...items, { ...created, joined: true, memberCount: 1 }]);
    setCurrentChannelId(created.id); setNewChannelOpen(false); setNewChannelName(""); setNewChannelTopic(""); setNewChannelDescription(""); setNewChannelCategoryId(""); setNewChannelPrivate(false); setNewChannelInviteOnly(false); setNewChannelPassword("");
  };
  const createCategory = async (event: FormEvent) => {
    event.preventDefault();
    const created = await api<Category>("/categories", { method: "POST", body: JSON.stringify({ name: newCategoryName, description: newCategoryDescription }) });
    setCategories((items) => [...items, created]);
    setNewCategoryName(""); setNewCategoryDescription(""); setNewCategoryOpen(false);
  };
  const decideJoinRequest = async (request: JoinRequest, decision: "approve" | "reject") => {
    if (!currentChannel) return;
    await api(`/channels/${currentChannel.id}/join-requests/${request.id}`, { method: "POST", body: JSON.stringify({ decision }) });
    setJoinRequests((items) => items.filter((item) => item.id !== request.id));
  };
  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const updated = await api<Profile>("/me", { method: "PATCH", body: JSON.stringify({ username: form.get("username"), displayName: form.get("displayName") }) });
    setProfile(updated); setPanel(null);
  };
  const searchHistory = async (event: FormEvent) => {
    event.preventDefault();
    if (search.trim().length < 2) return;
    setSearchResults(await api<ChatMessage[]>(`/search/messages?q=${encodeURIComponent(search)}`));
    setPanel("search");
  };
  const markRead = async (notice: Notification) => {
    if (!notice.readAt) { await api(`/notifications/${notice.id}/read`, { method: "POST", body: "{}" }); setNotifications((items) => items.map((item) => item.id === notice.id ? { ...item, readAt: new Date().toISOString() } : item)); }
  };
  const editTopic = async () => {
    if (!currentChannel || !["owner", "moderator"].includes(actorRole ?? "")) return;
    const channelId = currentChannel.id;
    const topic = window.prompt("Channel topic", currentChannel.topic);
    if (topic === null) return;
    try {
      const updated = await api<Channel>(`/channels/${channelId}`, { method: "PATCH", body: JSON.stringify({ topic }) });
      if (currentChannelIdRef.current === channelId) {
        setChannels((items) => items.map((item) => item.id === updated.id ? { ...item, topic: updated.topic } : item));
      }
    } catch (error) {
      if (isMissingChannelError(error)) {
        await recoverFromMissingChannel(channelId);
      } else {
        window.alert(error instanceof Error ? error.message : "Channel topic could not be saved");
      }
    }
  };
  const deleteMessage = async (message: ChatMessage) => {
    try {
      const deleted = await api<ChatMessage>(`/messages/${message.id}`, { method: "DELETE" });
      room.setMessages((items) => items.map((item) => item.id === deleted.id ? deleted : item));
    } catch (error) { window.alert(error instanceof Error ? error.message : "Message could not be deleted"); }
  };
  const toggleReaction = async (message: ChatMessage, emoji: string) => {
    const current = message.reactions?.find((reaction) => reaction.emoji === emoji);
    try {
      const reactions = current?.reacted
        ? await api<ChatMessage["reactions"]>(`/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`, { method: "DELETE" })
        : await api<ChatMessage["reactions"]>(`/messages/${message.id}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
      room.setMessages((items) => items.map((item) => item.id === message.id ? { ...item, reactions } : item));
    } catch (error) { window.alert(error instanceof Error ? error.message : "Reaction could not be changed"); }
  };
  const sendAttachment = async (file: File) => {
    const channelId = currentChannelId;
    if (channelId === null || activeDm) return;
    setUploading(true);
    try {
      const sent = await api<ChatMessage>(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ body: file.name }) });
      const upload = await api<{ uploadURL: string; objectPath: string }>("/storage/uploads/request-url", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }) });
      const uploaded = await fetch(upload.uploadURL, { method: "PUT", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
      if (!uploaded.ok) throw new Error("File upload failed");
      const attachment = await api<NonNullable<ChatMessage["attachments"]>[number]>(`/messages/${sent.id}/attachments`, { method: "POST", body: JSON.stringify({ objectPath: upload.objectPath, fileName: file.name, contentType: file.type || "application/octet-stream", fileSize: file.size }) });
      if (currentChannelIdRef.current === channelId) {
        room.setMessages((items) => [...items, { ...sent, attachments: [attachment] }]);
      }
    } catch (error) {
      if (isMissingChannelError(error)) {
        await recoverFromMissingChannel(channelId);
      } else {
        window.alert(error instanceof Error ? error.message : "File could not be shared");
      }
    }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ""; }
  };
  const moderate = async (member: Member, action: "mute" | "kick" | "ban" | "moderator") => {
    if (!currentChannel) return;
    await api(`/channels/${currentChannel.id}/moderation`, { method: "POST", body: JSON.stringify({ action, targetUserId: member.id, minutes: 10, reason: "Channel moderation" }) });
    if (action !== "mute") room.setMembers((items) => items.filter((item) => item.id !== member.id));
  };
  const blockUser = async (member: Member) => {
    await api(`/users/${member.id}/block`, { method: "POST", body: "{}" });
    window.alert(`${member.displayName} is now blocked.`);
  };
  if (!profile) return <div className="flex min-h-[100dvh] items-center justify-center bg-background font-mono text-sm text-muted-foreground">connecting to relay…</div>;

  return (
    <div className="irc-grid terminal-sheen flex min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <aside className="hidden w-[245px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-[76px] items-center justify-between border-b border-sidebar-border px-4">
           <div className="flex items-center gap-2.5"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Hash className="h-4 w-4" /></div><div><p className="font-mono text-sm font-bold">relay</p><p className="font-mono text-[9px] uppercase tracking-[.16em] text-muted-foreground">chat network</p></div></div>
           <div className="flex items-center gap-1"><button className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" onClick={() => setNewCategoryOpen(true)} aria-label="Create category">⌗</button><button className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" onClick={() => setNewChannelOpen(true)} aria-label="Create channel"><Plus className="h-4 w-4" /></button></div>
        </div>
        <div className="border-b border-sidebar-border p-3"><div className="relative"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="find a room" className="h-9 w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 pl-9 pr-3 font-mono text-[11px] outline-none focus:border-primary" /></div></div>
        <div className="flex-1 overflow-y-auto px-2 py-4">
           <p className="mb-2 px-2 font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">rooms</p>
           <div className="space-y-1">{visibleChannels.map((channel) => <button key={channel.id} onClick={() => channel.joined ? (setCurrentChannelId(channel.id), setActiveDm(null)) : void joinChannel(channel)} className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left font-mono text-xs ${channel.id === currentChannelId && !activeDm ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"}`}><span className="flex min-w-0 items-center gap-2"><Hash className={`h-3.5 w-3.5 ${channel.isPrivate ? "text-secondary-foreground" : "text-primary/70"}`} /><span className="truncate">{channel.name.slice(1)}</span></span><span className="ml-2 text-[10px]">{channel.accessStatus === "pending" ? "…" : channel.memberCount}</span></button>)}</div>
          <p className="mb-2 mt-7 px-2 font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">direct messages</p>
          <div className="relative"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="find a person" className="h-9 w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 pl-9 pr-3 font-mono text-[11px] outline-none focus:border-primary" /></div>
          {userResults.length > 0 && <div className="mt-2 space-y-1 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-1">{userResults.map((result) => <button key={result.id} onClick={() => { setActiveDm(result); setUserSearch(""); setUserResults([]); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-sidebar-accent"><Avatar user={result} size="sm" /><span className="min-w-0 truncate font-mono text-xs">{result.displayName}</span></button>)}</div>}
        </div>
        <button className="m-3 flex items-center gap-2 rounded-md bg-sidebar-accent/60 p-2.5 text-left" onClick={() => setPanel("profile")}><Avatar user={profile} size="sm" /><span className="min-w-0 flex-1 truncate"><span className="block font-mono text-xs">{profile.displayName}</span><span className="block font-mono text-[9px] text-muted-foreground">@{profile.username}</span></span><ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /></button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[76px] items-center justify-between border-b border-border bg-card/80 px-4 backdrop-blur sm:px-6">
           <div className="min-w-0">{activeDm ? <><p className="font-mono text-[10px] uppercase tracking-[.15em] text-secondary-foreground">direct message</p><h1 className="truncate font-mono text-base font-bold">@{activeDm.username}</h1></> : <><div className="flex items-center gap-2"><Hash className="h-4 w-4 text-primary" /><h1 className="truncate font-mono text-base font-bold">{currentChannel?.name ?? (channels.length > 0 ? "select a channel" : "no channels")}</h1>{currentChannel && <span className="rounded bg-chart-4/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-chart-4">{currentChannel.isPrivate ? "private" : "public"}</span>}{["owner", "moderator"].includes(actorRole ?? "") && <button onClick={editTopic} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-primary" title="Edit channel topic" aria-label="Edit channel topic"><Settings className="h-3.5 w-3.5" /></button>}</div><p className="mt-1 truncate text-[11px] text-muted-foreground">{currentChannel?.description || currentChannel?.topic}</p></>}</div>
           <div className="flex items-center gap-1.5">
            <form onSubmit={searchHistory} className="hidden items-center gap-2 rounded-md border border-border bg-background px-2 sm:flex"><Search className="h-3.5 w-3.5 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="search history" className="h-8 w-28 bg-transparent font-mono text-[10px] outline-none" /></form>
             {!activeDm && joinRequests.length > 0 && <button onClick={() => setShowRequests(true)} className="rounded-md border border-primary/40 px-2 py-1.5 font-mono text-[10px] text-primary hover:bg-primary/10">{joinRequests.length} request{joinRequests.length === 1 ? "" : "s"}</button>}
            <button onClick={() => setPanel("notifications")} className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Notifications"><Bell className="h-4 w-4" />{unread > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />}</button>
            <button onClick={() => setShowMembers((value) => !value)} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Toggle members"><Users className="h-4 w-4" /></button>
            <button onClick={() => signOut({ redirectUrl: basePath || "/" })} className="hidden rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:block" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-3 py-5 sm:px-6">
              {!activeDm && !currentChannel ? <div className="flex h-full min-h-[300px] flex-col items-center justify-center px-6 text-center"><Hash className="mb-3 h-8 w-8 text-primary" /><p className="font-mono text-sm">{channels.length === 0 ? "no channels available" : "select a channel"}</p><p className="mt-2 max-w-xs font-mono text-[11px] text-muted-foreground">{channels.length === 0 ? "You do not have access to any channels yet." : "Choose an available room from the channel list."}</p><button onClick={() => void refreshChannels().catch(() => setChannelRefreshError("Could not refresh the channel list."))} className="mt-4 rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"><RefreshCw className="mr-2 inline h-3.5 w-3.5" />refresh channels</button>{channelRefreshError && <p className="mt-3 font-mono text-[10px] text-destructive">{channelRefreshError}</p>}</div> : room.loading ? <p className="font-mono text-xs text-muted-foreground">loading history…</p> : room.messages.length === 0 ? <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center"><MessageSquare className="mb-3 h-8 w-8 text-primary" /><p className="font-mono text-sm">the room is quiet</p><p className="mt-2 max-w-xs font-mono text-[11px] text-muted-foreground">Start the conversation and make the room yours.</p></div> : <div className="space-y-5">{room.messages.map((message) => <div key={message.id} className={`group flex gap-3 ${message.kind === "system" ? "opacity-65" : ""}`}><Avatar user={message.sender} size="sm" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-2"><span className="font-mono text-xs font-bold text-secondary-foreground">{message.sender?.displayName ?? "system"}</span><span className="font-mono text-[10px] text-muted-foreground">{timeLabel(message.createdAt)}</span>{message.sender?.id === profile.id && message.kind !== "deleted" && <button onClick={() => deleteMessage(message)} className="ml-auto hidden font-mono text-[10px] text-muted-foreground hover:text-destructive group-hover:block">delete</button>}</div><p className={`mt-1 break-words text-sm leading-6 ${message.kind === "deleted" ? "italic text-muted-foreground" : "text-foreground/90"}`}>{message.body}</p>{message.attachments?.map((attachment) => <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="mt-2 flex max-w-xs items-center gap-2 rounded border border-border bg-muted/40 px-2.5 py-2 font-mono text-[10px] text-primary hover:border-primary"><Paperclip className="h-3.5 w-3.5" /><span className="truncate">{attachment.fileName}</span><span className="text-muted-foreground">{Math.ceil(attachment.fileSize / 1024)}kb</span></a>)}{message.kind !== "deleted" && <div className="mt-2 flex items-center gap-1">{["👍", "❤️", "🎉"].map((emoji) => { const reaction = message.reactions?.find((item) => item.emoji === emoji); return <button key={emoji} onClick={() => toggleReaction(message, emoji)} className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${reaction?.reacted ? "border-primary bg-primary/10" : "border-transparent bg-muted/40 hover:border-border"}`}>{emoji}{reaction?.count ? ` ${reaction.count}` : ""}</button>; })}</div>}</div></div>)}</div>}
              {Object.keys(typingUsers).length > 0 && <p className="mt-3 font-mono text-[10px] text-muted-foreground">{room.members.filter((member) => typingUsers[member.id]).map((member) => member.displayName).join(", ") || "Someone"} typing…</p>}
            </div>
             <div className="border-t border-border bg-card/70 px-3 pb-4 pt-3 sm:px-6"><form onSubmit={sendMessage} className="flex items-end gap-2 rounded-lg border border-input bg-background p-2 focus-within:border-primary"><input ref={fileInputRef} type="file" accept="image/*,text/*,application/pdf" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void sendAttachment(file); }} /><button type="button" onClick={() => fileInputRef.current?.click()} disabled={!currentChannelId || Boolean(activeDm) || uploading} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40" aria-label="Share a file"><Paperclip className="h-4 w-4" /></button><textarea disabled={!activeDm && !currentChannelId} value={draft} onChange={(event) => sendTyping(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={1} maxLength={500} placeholder={activeDm ? `message @${activeDm.username}` : currentChannel?.name ? `message ${currentChannel.name}` : "Select a channel to message"} className="max-h-28 min-h-[28px] flex-1 resize-none bg-transparent px-2 py-1 font-mono text-xs outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed" /><button type="submit" disabled={!draft.trim() || uploading || (!activeDm && !currentChannelId)} className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"><MessageCircle className="h-4 w-4" /></button></form><div className="mt-2 flex justify-between px-1 font-mono text-[9px] text-muted-foreground"><span><b>enter</b> send · <b>shift + enter</b> new line · <b>paperclip</b> share</span><span className={connection === "live" ? "text-chart-4" : "text-primary"}>● {uploading ? "uploading" : connection}</span></div></div>
          </section>
          {showMembers && !activeDm && <aside className="hidden w-[285px] shrink-0 border-l border-border bg-card/70 lg:flex lg:flex-col"><div className="border-b border-border px-4 py-5"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">in the room</p><p className="mt-1 font-mono text-lg font-bold">{room.members.length} <span className="text-xs font-normal text-muted-foreground">people</span></p></div><div className="flex-1 overflow-y-auto p-3">{room.members.map((member) => <div key={member.id} className="group rounded-md px-2 py-2 hover:bg-muted"><div className="flex items-center gap-2"><Avatar user={member} size="sm" /><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs">{member.displayName} {member.status === "online" ? <span className="ml-1 text-chart-4">●</span> : <span className="ml-1 text-muted-foreground">○</span>}</p><p className="font-mono text-[9px] text-muted-foreground">@{member.username} · {member.role}</p></div><button onClick={() => setActiveDm(member)} className="rounded p-1 text-muted-foreground hover:text-primary" aria-label={`Message ${member.displayName}`}><MessageCircle className="h-3.5 w-3.5" /></button></div>{member.id !== profile.id && <div className="mt-2 hidden gap-1 group-hover:flex"><button onClick={() => blockUser(member)} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-accent hover:text-accent">block</button>{actorRole === "owner" && member.role === "member" && <button onClick={() => moderate(member, "moderator")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-secondary-foreground hover:text-secondary-foreground">mod</button>}{["owner", "moderator"].includes(actorRole ?? "") && member.role === "member" && <><button onClick={() => moderate(member, "mute")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary">mute</button><button onClick={() => moderate(member, "kick")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary">kick</button><button onClick={() => moderate(member, "ban")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-destructive hover:text-destructive">ban</button></>}</div>}</div>)}</div></aside>}
        </div>
      </main>

      {panel === "notifications" && <Overlay title="Notifications" onClose={() => setPanel(null)}><div className="space-y-2">{notifications.length === 0 ? <p className="font-mono text-xs text-muted-foreground">You are all caught up.</p> : notifications.map((notice) => <button key={notice.id} onClick={() => markRead(notice)} className={`flex w-full items-start gap-3 rounded-lg p-3 text-left ${notice.readAt ? "bg-muted/30" : "bg-primary/10"}`}><Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span><span className="block font-mono text-xs">{notice.body}</span><span className="mt-1 block font-mono text-[10px] text-muted-foreground">{timeLabel(notice.createdAt)} {notice.readAt ? "· read" : "· new"}</span></span></button>)}</div></Overlay>}
      {panel === "profile" && <Overlay title="Your profile" onClose={() => setPanel(null)}><form onSubmit={saveProfile} className="space-y-4"><div className="flex items-center gap-3"><Avatar user={profile} size="lg" /><div><p className="font-mono text-sm font-bold">{profile.displayName}</p><p className="font-mono text-xs text-muted-foreground">Account profile · {profile.role === "admin" ? "admin / developer" : profile.role?.replace("_", " ") || "member"}</p></div></div><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">username</span><input name="username" defaultValue={profile.username} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">display name</span><input name="displayName" defaultValue={profile.displayName} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><button className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground"><Check className="h-4 w-4" /> save profile</button><a href={`${basePath}/communities`} className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 font-mono text-xs text-muted-foreground hover:bg-muted"><Users className="h-4 w-4" /> open communities</a><a href={`${basePath}/admin`} className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 font-mono text-xs text-muted-foreground hover:bg-muted"><Shield className="h-4 w-4" /> open platform console</a><button type="button" onClick={() => signOut({ redirectUrl: basePath || "/" })} className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 font-mono text-xs text-muted-foreground hover:bg-muted"><LogOut className="h-4 w-4" /> sign out</button></form></Overlay>}
       {showRequests && <Overlay title={`Join requests · ${currentChannel?.name ?? ""}`} onClose={() => setShowRequests(false)}><div className="space-y-2">{joinRequests.length === 0 ? <p className="font-mono text-xs text-muted-foreground">No pending requests.</p> : joinRequests.map((request) => <div key={request.id} className="flex items-center gap-3 rounded-lg border border-border p-3"><Avatar user={request.user} size="sm" /><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs font-bold">{request.user.displayName}</p><p className="font-mono text-[10px] text-muted-foreground">@{request.user.username}</p></div><button onClick={() => void decideJoinRequest(request, "reject")} className="rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground hover:text-destructive">decline</button><button onClick={() => void decideJoinRequest(request, "approve")} className="rounded bg-primary px-2 py-1 font-mono text-[10px] font-bold text-primary-foreground">approve</button></div>)}</div></Overlay>}
      {panel === "search" && <Overlay title={`Search results for “${search}”`} onClose={() => setPanel(null)}><div className="space-y-4">{searchResults.length === 0 ? <p className="font-mono text-xs text-muted-foreground">No messages found.</p> : searchResults.map((message) => <div key={message.id} className="border-b border-border pb-3"><div className="flex justify-between font-mono text-[10px] text-muted-foreground"><span className="text-secondary-foreground">{message.sender?.displayName}</span><span>{timeLabel(message.createdAt)}</span></div><p className="mt-1 text-sm">{message.body}</p></div>)}</div></Overlay>}
       {newChannelOpen && <Overlay title="Create a room" onClose={() => setNewChannelOpen(false)}><form onSubmit={createChannel} className="space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">channel name</span><input autoFocus required value={newChannelName} onChange={(event) => setNewChannelName(event.target.value)} placeholder="#room-name" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">topic</span><input value={newChannelTopic} onChange={(event) => setNewChannelTopic(event.target.value)} placeholder="What is this room about?" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">description</span><input value={newChannelDescription} onChange={(event) => setNewChannelDescription(event.target.value)} placeholder="A short description for members" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label>{categories.length > 0 && <label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">category</span><select value={newChannelCategoryId} onChange={(event) => setNewChannelCategoryId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary"><option value="">no category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}<label className="flex items-center gap-2 font-mono text-xs"><input type="checkbox" checked={newChannelPrivate} onChange={(event) => setNewChannelPrivate(event.target.checked)} /> private room (owner approval)</label><label className="flex items-center gap-2 font-mono text-xs"><input type="checkbox" checked={newChannelInviteOnly} onChange={(event) => setNewChannelInviteOnly(event.target.checked)} /> invite-only</label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">optional password</span><input type="password" minLength={4} value={newChannelPassword} onChange={(event) => setNewChannelPassword(event.target.value)} placeholder="at least 4 characters" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><button className="w-full rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground">create room</button></form></Overlay>}
       {newCategoryOpen && <Overlay title="Create a category" onClose={() => setNewCategoryOpen(false)}><form onSubmit={createCategory} className="space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">category name</span><input autoFocus required value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="design team" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">description</span><input value={newCategoryDescription} onChange={(event) => setNewCategoryDescription(event.target.value)} placeholder="What belongs here?" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><button className="w-full rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground">create category</button></form></Overlay>}
    </div>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-40 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center"><div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="font-mono text-base font-bold">{title}</h2><button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close"><X className="h-4 w-4" /></button></div>{children}</div></div>;
}

type AdminStatus = { isAdmin: boolean; bootstrapAvailable: boolean; profile: Pick<Profile, "id" | "username" | "displayName"> };
type AdminOverview = {
  stats: { users: number; channels: number; messages: number; online: number };
  users: Array<{ id: string; username: string; displayName: string; role: string; status: string; createdAt: string; lastSeenAt: string }>;
  channels: Array<{ id: number; name: string; topic: string; memberCount: number; createdAt: string }>;
  recentMessages: Array<{ id: string; body: string; sender: string; channelId: number | null; createdAt: string }>;
};

function AdminDashboard() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const loadOverview = () => api<AdminOverview>("/admin/overview").then(setOverview).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load admin overview"));
  useEffect(() => {
    api<AdminStatus>("/admin/status").then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load admin status")).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (status?.isAdmin) loadOverview(); }, [status?.isAdmin]);
  const claimAdmin = async () => {
    setWorking(true);
    try {
      await api("/admin/claim", { method: "POST", body: "{}" });
      setStatus((current) => current ? { ...current, isAdmin: true, bootstrapAvailable: false } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not claim admin access"); }
    finally { setWorking(false); }
  };
  const changeRole = async (userId: string, role: "admin" | "member") => {
    setWorking(true);
    try { await api(`/admin/users/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role }) }); await loadOverview(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update role"); }
    finally { setWorking(false); }
  };
  const statCards: Array<[string, number, LucideIcon]> = [
    ["users", overview?.stats.users ?? 0, UserRound],
    ["online", overview?.stats.online ?? 0, Sparkles],
    ["channels", overview?.stats.channels ?? 0, Hash],
    ["messages", overview?.stats.messages ?? 0, MessageSquare],
  ];
  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-background font-mono text-sm text-muted-foreground">loading admin console…</div>;
  if (error && !status) return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 font-mono text-sm text-destructive">{error}</div>;
  if (!status?.isAdmin) return <div className="min-h-[100dvh] bg-background px-5 py-8 text-foreground sm:px-10"><div className="mx-auto max-w-2xl"><a href={`${basePath}/chat`} className="font-mono text-xs text-muted-foreground hover:text-primary">← return to relay</a><div className="mt-16 rounded-2xl border border-border bg-card p-8"><Shield className="h-8 w-8 text-primary" /><p className="mt-6 font-mono text-[10px] uppercase tracking-[.18em] text-primary">admin setup</p><h1 className="mt-2 font-mono text-3xl font-bold">Claim the admin account</h1><p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">{status?.bootstrapAvailable ? "No admin account exists yet. Claim the first admin seat for this signed-in account to manage Relay." : "An admin account has already been claimed. Ask that admin to promote your account if you need access."}</p>{status?.bootstrapAvailable && <button disabled={working} onClick={claimAdmin} className="mt-8 rounded-lg bg-primary px-5 py-3 font-mono text-xs font-bold text-primary-foreground disabled:opacity-50">{working ? "claiming…" : "claim admin access"}</button>}{error && <p className="mt-4 font-mono text-xs text-destructive">{error}</p>}</div></div></div>;
  return <div className="min-h-[100dvh] bg-background text-foreground"><header className="border-b border-border bg-card/80"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-10"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Shield className="h-5 w-5" /></div><div><p className="font-mono font-bold">relay admin</p><p className="font-mono text-[9px] uppercase tracking-[.18em] text-muted-foreground">network control room</p></div></div><a href={`${basePath}/chat`} className="rounded-md border border-border px-3 py-2 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground">back to chat</a></div></header><main className="mx-auto max-w-7xl px-5 py-8 sm:px-10"><div className="mb-8"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-primary">overview</p><h1 className="mt-2 font-mono text-3xl font-bold">Keep the network healthy.</h1><p className="mt-2 text-sm text-muted-foreground">Manage accounts, roles, public rooms, and recent activity.</p></div>{error && <div className="mb-5 rounded-lg border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive">{error}</div>}<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{statCards.map(([label, value, Icon]) => <div key={label} className="rounded-xl border border-border bg-card p-5"><Icon className="h-4 w-4 text-primary" /><p className="mt-5 font-mono text-3xl font-bold">{value}</p><p className="mt-1 font-mono text-[10px] uppercase tracking-[.14em] text-muted-foreground">{label}</p></div>)}</div><div className="mt-8 grid gap-5 xl:grid-cols-[1.2fr_.8fr]"><section className="rounded-xl border border-border bg-card"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-mono text-sm font-bold">accounts</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Manage admin access</p></div><Users className="h-4 w-4 text-muted-foreground" /></div><div className="divide-y divide-border">{overview?.users.map((account) => <div key={account.id} className="flex items-center gap-3 px-5 py-3"><div className={`h-2 w-2 rounded-full ${account.status === "online" ? "bg-chart-4" : "bg-muted-foreground/40"}`} /><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs">{account.displayName}</p><p className="font-mono text-[10px] text-muted-foreground">@{account.username} · joined {timeLabel(account.createdAt)}</p></div><span className={`rounded px-2 py-1 font-mono text-[9px] uppercase ${account.role === "admin" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>{account.role}</span>{account.id !== status.profile.id && <button disabled={working} onClick={() => changeRole(account.id, account.role === "admin" ? "member" : "admin")} className="rounded border border-border px-2 py-1 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40">{account.role === "admin" ? "remove" : "promote"}</button>}</div>)}</div></section><div className="space-y-5"><section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">public rooms</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{overview?.channels.length ?? 0} indexed channels</p></div><div className="divide-y divide-border">{overview?.channels.map((channel) => <div key={channel.id} className="px-5 py-3"><div className="flex justify-between font-mono text-xs"><span className="text-secondary-foreground">{channel.name}</span><span className="text-muted-foreground">{channel.memberCount} members</span></div><p className="mt-1 truncate text-[11px] text-muted-foreground">{channel.topic || "No topic set"}</p></div>)}</div></section><section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">recent messages</h2></div><div className="divide-y divide-border">{overview?.recentMessages.slice(0, 6).map((message) => <div key={message.id} className="px-5 py-3"><div className="flex justify-between font-mono text-[10px]"><span className="text-secondary-foreground">{message.sender}</span><span className="text-muted-foreground">{timeLabel(message.createdAt)}</span></div><p className="mt-1 truncate text-xs">{message.body}</p></div>)}</div></section></div></div></main></div>;
}

type ConsoleHealth = { api: string; database: string; databaseLatencyMs: number; environment: string; uptimeSeconds: number; checkedAt: string };
type ConsoleOverview = {
  stats: { users: number; channels: number; messages: number; online: number; admins: number };
  users: Array<{ id: string; username: string; displayName: string; role: string; status: string; createdAt: string; lastSeenAt: string }>;
  channels: Array<{ id: number; name: string; topic: string; memberCount: number; createdAt: string }>;
  recentMessages: Array<{ id: string; body: string; sender: string; channelId: number | null; createdAt: string }>;
  activity: Array<{ id: string; action: string; targetId?: string | null; targetLabel?: string | null; details?: string | null; createdAt: string; actor?: string | { username?: string; displayName?: string } | null }>;
};

function EmptyAdminState({ label }: { label: string }) {
  return <div className="flex items-center gap-3 px-5 py-8 font-mono text-xs text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-primary/70" />{label}</div>;
}

function AdminActivityRow({ item, detailed = false }: { item: ConsoleOverview["activity"][number]; detailed?: boolean; actor?: (value: ConsoleOverview["activity"][number]["actor"]) => string }) {
  const actor = typeof item.actor === "string" ? item.actor : item.actor?.displayName ?? item.actor?.username ?? "system";
  return <div className="flex gap-3 px-5 py-3.5"><div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"><Activity className="h-3.5 w-3.5" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[10px]"><span className="font-bold text-foreground">{item.action}</span>{item.targetLabel && <span className="truncate text-secondary-foreground">{item.targetLabel}</span>}<span className="text-muted-foreground">{timeLabel(item.createdAt)}</span></div>{detailed && <p className="mt-1 text-[11px] text-muted-foreground">{item.details || `Performed by ${actor}`}</p>}<p className="mt-1 font-mono text-[9px] text-muted-foreground/70">actor: {actor}</p></div></div>;
}

function HealthCell({ label, value, icon: Icon }: { label: string; value: string; icon: LucideIcon }) {
  const isHealthy = value === "operational";
  return <div className="bg-card p-5"><div className="flex items-center gap-2"><Icon className="h-3.5 w-3.5 text-primary" /><span className="font-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground">{label}</span></div><p className={`mt-3 font-mono text-sm font-bold ${isHealthy ? "text-chart-4" : ""}`}>{value}</p></div>;
}

function AdminHealthCard({ health, onOpen }: { health: ConsoleHealth | null; onOpen: () => void }) {
  const healthy = health && health.api === "operational" && health.database === "operational";
  return <button onClick={onOpen} className="w-full rounded-lg border border-border bg-card p-5 text-left transition-colors hover:border-primary/50"><div className="flex items-start justify-between"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">system pulse</p><p className="mt-2 flex items-center gap-2 font-mono text-sm font-bold"><span className={`h-2 w-2 rounded-full ${healthy ? "bg-chart-4" : "bg-destructive"}`} />{healthy ? "all systems operational" : "attention required"}</p></div><Server className="h-4 w-4 text-primary" /></div>{health && <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4"><div><p className="font-mono text-[9px] uppercase text-muted-foreground">api</p><p className="mt-1 font-mono text-xs text-chart-4">{health.api}</p></div><div><p className="font-mono text-[9px] uppercase text-muted-foreground">db</p><p className="mt-1 font-mono text-xs text-chart-4">{health.database}</p></div><div><p className="font-mono text-[9px] uppercase text-muted-foreground">latency</p><p className="mt-1 font-mono text-xs">{health.databaseLatencyMs}ms</p></div></div>}<p className="mt-4 font-mono text-[10px] text-primary">open system status →</p></button>;
}

function AdminAccountsPanel({ accounts, query, setQuery, roleFilter, setRoleFilter, statusFilter, setStatusFilter, currentId, working, onRole }: { accounts: ConsoleOverview["users"]; query: string; setQuery: (value: string) => void; roleFilter: string; setRoleFilter: (value: string) => void; statusFilter: string; setStatusFilter: (value: string) => void; currentId: string; working: boolean; onRole: (account: ConsoleOverview["users"][number], role: "admin" | "moderator" | "community_admin" | "member") => void }) {
  return <section className="rounded-lg border border-border bg-card"><div className="border-b border-border p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-mono text-sm font-bold">account directory</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{accounts.length} matching accounts</p></div><Users className="h-4 w-4 text-muted-foreground" /></div><div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]"><div className="relative"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search username or display name" className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 font-mono text-[11px] outline-none focus:border-primary" data-testid="input-account-search" /></div><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 font-mono text-[10px] outline-none focus:border-primary" data-testid="select-account-role"><option value="all">all roles</option><option value="admin">admins / developers</option><option value="moderator">moderators</option><option value="community_admin">community admins</option><option value="member">members</option></select><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 font-mono text-[10px] outline-none focus:border-primary" data-testid="select-account-status"><option value="all">all status</option><option value="online">online</option><option value="offline">offline</option></select></div></div><div className="divide-y divide-border">{accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5"><span className={`h-2 w-2 shrink-0 rounded-full ${account.status === "online" ? "bg-chart-4" : "bg-muted-foreground/35"}`} /><div className="min-w-[160px] flex-1"><p className="truncate font-mono text-xs font-bold">{account.displayName}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">@{account.username} · joined {timeLabel(account.createdAt)}</p></div><span className={`rounded px-2 py-1 font-mono text-[9px] uppercase ${account.role === "admin" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>{account.role === "admin" ? "admin / developer" : account.role}</span>{account.id === currentId ? <span className="font-mono text-[9px] text-muted-foreground">you</span> : <select disabled={working} value={account.role} onChange={(event) => onRole(account, event.target.value as "admin" | "moderator" | "community_admin" | "member")} className="rounded border border-border bg-background px-2 py-1.5 font-mono text-[9px] text-muted-foreground outline-none hover:border-primary hover:text-primary disabled:opacity-40" data-testid={`select-role-${account.id}`}><option value="admin">admin / developer</option><option value="moderator">moderator</option><option value="community_admin">community admin</option><option value="member">member</option></select>}</div>)}{accounts.length === 0 && <EmptyAdminState label="No accounts match these filters." />}</div></section>;
}

function AdminChannelsPanel({ channels, editingChannel, topicDraft, setTopicDraft, working, onEdit, onSave, onCancel, onClear }: { channels: ConsoleOverview["channels"]; editingChannel: number | null; topicDraft: string; setTopicDraft: (value: string) => void; working: boolean; onEdit: (channel: ConsoleOverview["channels"][number]) => void; onSave: (id: number) => void; onCancel: () => void; onClear: (channel: ConsoleOverview["channels"][number]) => void }) {
  return <section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><div className="flex items-center justify-between"><div><h2 className="font-mono text-sm font-bold">channel registry</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{channels.length} public rooms</p></div><Hash className="h-4 w-4 text-primary" /></div></div><div className="divide-y divide-border">{channels.map((channel) => <div key={channel.id} className="px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="font-mono text-sm font-bold text-secondary-foreground">{channel.name}</span><span className="font-mono text-[9px] text-muted-foreground">{channel.memberCount} members</span></div>{editingChannel === channel.id ? <div className="mt-3 flex flex-col gap-2 sm:flex-row"><input autoFocus value={topicDraft} onChange={(event) => setTopicDraft(event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-[11px] outline-none focus:border-primary" data-testid={`input-topic-${channel.id}`} /><button disabled={working} onClick={() => onSave(channel.id)} className="flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50"><Save className="h-3.5 w-3.5" />save</button><button onClick={onCancel} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground">cancel</button></div> : <p className="mt-2 truncate text-xs text-muted-foreground">{channel.topic || "No topic set"}</p>}</div>{editingChannel !== channel.id && <div className="flex gap-2"><button onClick={() => onEdit(channel)} className="rounded-md border border-border px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary"><Settings className="mr-1 inline h-3 w-3" />edit topic</button><button onClick={() => onClear(channel)} className="rounded-md border border-destructive/30 px-2.5 py-1.5 font-mono text-[9px] text-destructive hover:bg-destructive/10"><Trash2 className="mr-1 inline h-3 w-3" />clear history</button></div>}</div><p className="mt-3 font-mono text-[9px] text-muted-foreground/70">created {timeLabel(channel.createdAt)}</p></div>)}{channels.length === 0 && <EmptyAdminState label="No public channels have been created." />}</div></section>;
}

function AdminConfirmDialog({ title, description, confirmLabel, destructive, working, onConfirm, onCancel }: { title: string; description: string; confirmLabel: string; destructive?: boolean; working: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/75 p-4 backdrop-blur-sm sm:items-center"><div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${destructive ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"}`}>{destructive ? <AlertTriangle className="h-4 w-4" /> : <Shield className="h-4 w-4" />}</div><div><h2 className="font-mono text-sm font-bold">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p></div></div><div className="mt-6 flex justify-end gap-2"><button onClick={onCancel} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:bg-muted">cancel</button><button disabled={working} onClick={onConfirm} className={`rounded-md px-3 py-2 font-mono text-[10px] font-bold disabled:opacity-50 ${destructive ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`} data-testid="button-confirm-admin-action">{working ? "working…" : confirmLabel}</button></div></div></div>;
}

function AdminConsole() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [overview, setOverview] = useState<ConsoleOverview | null>(null);
  const [directory, setDirectory] = useState<ConsoleOverview["users"]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [health, setHealth] = useState<ConsoleHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [section, setSection] = useState<"overview" | "accounts" | "channels" | "activity" | "system">("overview");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [pendingRole, setPendingRole] = useState<{ id: string; label: string; role: "admin" | "moderator" | "community_admin" | "member" } | null>(null);
  const [editingChannel, setEditingChannel] = useState<number | null>(null);
  const [topicDraft, setTopicDraft] = useState("");
  const [pendingClear, setPendingClear] = useState<{ id: number; name: string } | null>(null);
  const load = async () => { setError(""); try { const [nextOverview, nextHealth] = await Promise.all([api<ConsoleOverview>("/admin/overview"), api<ConsoleHealth>("/admin/health")]); setOverview(nextOverview); setHealth(nextHealth); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load the operations console"); } };
  useEffect(() => { api<AdminStatus>("/admin/status").then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load admin status")).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (status?.isAdmin) void load(); }, [status?.isAdmin]);
  useEffect(() => {
    if (!status?.isAdmin || section !== "accounts") return;
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    api<ConsoleOverview["users"] | { users: ConsoleOverview["users"] }>(`/admin/users${params.toString() ? `?${params.toString()}` : ""}`)
      .then((result) => { setDirectory(Array.isArray(result) ? result : result.users); setDirectoryLoaded(true); })
      .catch(() => { setDirectory([]); setDirectoryLoaded(true); });
  }, [status?.isAdmin, section, query, roleFilter, statusFilter]);
  const claim = async () => { setWorking(true); try { await api("/admin/claim", { method: "POST", body: "{}" }); setStatus((value) => value ? { ...value, isAdmin: true, bootstrapAvailable: false } : value); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not claim admin access"); } finally { setWorking(false); } };
  const updateRole = async () => { if (!pendingRole) return; setWorking(true); try { await api(`/admin/users/${pendingRole.id}/role`, { method: "PATCH", body: JSON.stringify({ role: pendingRole.role }) }); setNotice(`Role updated for ${pendingRole.label}.`); setPendingRole(null); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update role"); } finally { setWorking(false); } };
  const saveTopic = async (id: number) => { setWorking(true); try { await api(`/admin/channels/${id}`, { method: "PATCH", body: JSON.stringify({ topic: topicDraft }) }); setEditingChannel(null); setNotice("Channel topic saved."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save channel topic"); } finally { setWorking(false); } };
  const clearHistory = async () => { if (!pendingClear) return; setWorking(true); try { await api(`/admin/channels/${pendingClear.id}/messages`, { method: "DELETE", body: JSON.stringify({ confirm: true }) }); setNotice(`History cleared for ${pendingClear.name}.`); setPendingClear(null); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not clear channel history"); } finally { setWorking(false); } };
  const accounts = (directoryLoaded ? directory : overview?.users ?? []).filter((account) => { const q = query.trim().toLowerCase(); return (!q || account.username.toLowerCase().includes(q) || account.displayName.toLowerCase().includes(q)) && (roleFilter === "all" || account.role === roleFilter) && (statusFilter === "all" || account.status === statusFilter); });
  const nav: Array<[typeof section, string, LucideIcon]> = [["overview", "overview", LayoutDashboard], ["accounts", "accounts", Users], ["channels", "channels", Hash], ["activity", "activity", Activity], ["system", "system status", Server]];
  const title = nav.find(([key]) => key === section)?.[1] ?? "overview";
  const actor = (value: ConsoleOverview["activity"][number]["actor"]) => typeof value === "string" ? value : value?.displayName ?? value?.username ?? "system";
  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-background font-mono text-sm text-muted-foreground">loading admin console…</div>;
  if (error && !status) return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 font-mono text-sm text-destructive">{error}</div>;
  if (!status?.isAdmin) return <div className="min-h-[100dvh] bg-background px-5 py-8 text-foreground sm:px-10"><div className="mx-auto max-w-2xl"><a href={`${basePath}/chat`} className="font-mono text-xs text-muted-foreground hover:text-primary">← return to relay</a><div className="mt-16 rounded-2xl border border-border bg-card p-8"><Shield className="h-8 w-8 text-primary" /><p className="mt-6 font-mono text-[10px] uppercase tracking-[.18em] text-primary">platform access</p><h1 className="mt-2 font-mono text-3xl font-bold">Admin access is managed by the platform</h1><p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">Your account is a member. A platform operator must explicitly provision administrative access before you can enter this control room.</p></div></div></div>;
  if (!status?.isAdmin) return <div className="min-h-[100dvh] bg-background px-5 py-8 text-foreground sm:px-10"><div className="mx-auto max-w-2xl"><a href={`${basePath}/chat`} className="font-mono text-xs text-muted-foreground hover:text-primary">← return to relay</a><div className="mt-16 rounded-2xl border border-border bg-card p-8"><Shield className="h-8 w-8 text-primary" /><p className="mt-6 font-mono text-[10px] uppercase tracking-[.18em] text-primary">admin setup</p><h1 className="mt-2 font-mono text-3xl font-bold">Claim the admin account</h1><p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">{status?.bootstrapAvailable ? "No admin account exists yet. Claim the first admin seat for this signed-in account to manage Relay." : "An admin account has already been claimed. Ask that admin to promote your account if you need access."}</p>{status?.bootstrapAvailable && <button disabled={working} onClick={claim} className="mt-8 rounded-lg bg-primary px-5 py-3 font-mono text-xs font-bold text-primary-foreground disabled:opacity-50">{working ? "claiming…" : "claim admin access"}</button>}{error && <p className="mt-4 font-mono text-xs text-destructive">{error}</p>}</div></div></div>;
  const stats: Array<[string, number, LucideIcon]> = [["users", overview?.stats.users ?? 0, UserRound], ["online", overview?.stats.online ?? 0, Sparkles], ["channels", overview?.stats.channels ?? 0, Hash], ["messages", overview?.stats.messages ?? 0, MessageSquare], ["admins", overview?.stats.admins ?? 0, Shield]];
  return (
    <div className="irc-grid terminal-sheen min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex min-h-[72px] max-w-[1500px] items-center justify-between gap-4 px-4 sm:px-7">
          <div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Shield className="h-5 w-5" /></div><div><p className="font-mono text-sm font-bold">relay / control room</p><p className="font-mono text-[9px] uppercase tracking-[.18em] text-muted-foreground">trusted network operations</p></div></div>
          <div className="flex items-center gap-2"><div className="hidden items-center gap-2 border-r border-border pr-3 sm:flex"><span className="h-2 w-2 rounded-full bg-chart-4" /><span className="font-mono text-[10px] text-muted-foreground">authenticated</span></div><button disabled={working} onClick={() => void load()} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" aria-label="Refresh console" data-testid="button-refresh-admin"><RefreshCw className={`h-4 w-4 ${working ? "animate-spin" : ""}`} /></button><a href={`${basePath}/chat`} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground">back to chat</a></div>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1500px]">
        <aside className="hidden w-[218px] shrink-0 border-r border-border px-3 py-6 lg:block">
          <p className="px-3 font-mono text-[9px] uppercase tracking-[.2em] text-muted-foreground">operations</p>
          <nav className="mt-3 space-y-1">{nav.map(([key, label, Icon]) => <button key={key} onClick={() => setSection(key)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left font-mono text-xs ${section === key ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`} data-testid={`button-admin-nav-${key}`}><Icon className="h-4 w-4" />{label}{section === key && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}</button>)}</nav>
          <div className="mt-10 border-t border-border px-3 pt-5"><p className="font-mono text-[9px] uppercase tracking-[.16em] text-muted-foreground">signed in as</p><p className="mt-3 truncate font-mono text-xs font-bold">{status.profile.displayName}</p><p className="mt-1 truncate font-mono text-[10px] text-secondary-foreground">@{status.profile.username}</p><p className="mt-3 inline-flex items-center gap-1.5 rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary"><Shield className="h-3 w-3" /> administrator</p></div>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-5 sm:px-7 sm:py-7">
          <div className="mb-5 flex gap-1 overflow-x-auto pb-1 lg:hidden">{nav.map(([key, label, Icon]) => <button key={key} onClick={() => setSection(key)} className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 font-mono text-[10px] ${section === key ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground"}`}><Icon className="h-3.5 w-3.5" />{label}</button>)}</div>
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-primary">/{title}</p><h1 className="mt-2 font-mono text-2xl font-bold tracking-tight sm:text-3xl">{section === "overview" ? "Network at a glance." : section === "accounts" ? "Account governance." : section === "channels" ? "Public rooms." : section === "activity" ? "A clear audit trail." : "System status."}</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{section === "overview" ? "The essential signals for keeping Relay available, safe, and understandable." : section === "accounts" ? "Review identity, presence, and privilege without leaving the control room." : section === "channels" ? "Keep room context useful and remove history only when you mean to." : section === "activity" ? "Recent administrative changes and network events, newest first." : "A live read on the services behind the conversation."}</p></div><div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{health ? `checked ${timeLabel(health.checkedAt)}` : "checking signals"}</div></div>
          {error && <div className="mb-5 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span><button onClick={() => void load()} className="ml-auto underline">retry</button></div>}
          {notice && <div className="mb-5 flex items-center gap-2 rounded-md border border-chart-4/30 bg-chart-4/10 p-3 font-mono text-xs text-chart-4"><CheckCircle2 className="h-4 w-4" />{notice}<button onClick={() => setNotice("")} className="ml-auto" aria-label="Dismiss notice"><X className="h-3.5 w-3.5" /></button></div>}
          {!overview ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="h-28 animate-pulse rounded-lg border border-border bg-card" />)}</div> : section === "overview" ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{stats.map(([label, value, Icon]) => <div key={label} className="rounded-lg border border-border bg-card p-4"><div className="flex items-center justify-between"><Icon className="h-4 w-4 text-primary" /><span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">live</span></div><p className="mt-5 font-mono text-3xl font-bold">{value}</p><p className="mt-1 font-mono text-[10px] uppercase tracking-[.14em] text-muted-foreground">{label}</p></div>)}</div>
              <div className="grid gap-5 xl:grid-cols-[1.12fr_.88fr]"><section className="rounded-lg border border-border bg-card"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-mono text-sm font-bold">recent activity</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">The last operational changes</p></div><button onClick={() => setSection("activity")} className="font-mono text-[10px] text-primary hover:underline">view all</button></div><div className="divide-y divide-border">{overview.activity.slice(0, 6).map((item) => <AdminActivityRow key={item.id} item={item} actor={actor} />)}{overview.activity.length === 0 && <EmptyAdminState label="No activity recorded yet." />}</div></section><div className="space-y-5"><AdminHealthCard health={health} onOpen={() => setSection("system")} /><section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">recent messages</h2></div><div className="divide-y divide-border">{overview.recentMessages.slice(0, 5).map((message) => <div key={message.id} className="px-5 py-3"><div className="flex justify-between gap-3 font-mono text-[10px]"><span className="truncate text-secondary-foreground">{message.sender}</span><span className="shrink-0 text-muted-foreground">{timeLabel(message.createdAt)}</span></div><p className="mt-1 truncate text-xs">{message.body}</p></div>)}{overview.recentMessages.length === 0 && <EmptyAdminState label="No messages have been sent yet." />}</div></section></div></div>
            </div>
           ) : section === "accounts" ? <AdminAccountsPanel accounts={accounts} query={query} setQuery={setQuery} roleFilter={roleFilter} setRoleFilter={setRoleFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} currentId={status.profile.id} working={working} onRole={(account, role) => setPendingRole({ id: account.id, label: account.displayName, role })} /> : section === "channels" ? <AdminChannelsPanel channels={overview.channels} editingChannel={editingChannel} topicDraft={topicDraft} setTopicDraft={setTopicDraft} working={working} onEdit={(channel) => { setEditingChannel(channel.id); setTopicDraft(channel.topic); }} onSave={saveTopic} onCancel={() => setEditingChannel(null)} onClear={(channel) => setPendingClear({ id: channel.id, name: channel.name })} /> : section === "activity" ? (
            <section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">audit stream</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{overview.activity.length} recorded events</p></div><div className="divide-y divide-border">{overview.activity.map((item) => <AdminActivityRow key={item.id} item={item} actor={actor} detailed />)}{overview.activity.length === 0 && <EmptyAdminState label="No administrative activity yet." />}</div></section>
          ) : (
            <div className="grid gap-5 xl:grid-cols-[1.25fr_.75fr]"><section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">service health</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Last probe: {health ? timeLabel(health.checkedAt) : "unavailable"}</p></div><div className="grid gap-px bg-border sm:grid-cols-2">{health ? <><HealthCell label="api" value={health.api} icon={Radio} /><HealthCell label="database" value={health.database} icon={Database} /><HealthCell label="database latency" value={`${health.databaseLatencyMs} ms`} icon={Clock3} /><HealthCell label="environment" value={health.environment} icon={Server} /><HealthCell label="uptime" value={`${Math.floor(health.uptimeSeconds / 3600)}h`} icon={Activity} /></> : <EmptyAdminState label="Health data is not available." />}</div></section><div className="rounded-lg border border-border bg-card p-5"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">administrator</p><div className="mt-5 flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-lg bg-secondary font-mono text-sm font-bold text-secondary-foreground">{initials(status.profile.displayName)}</div><div><p className="font-mono text-sm font-bold">{status.profile.displayName}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">@{status.profile.username}</p></div></div><div className="mt-6 border-t border-border pt-4 font-mono text-[10px] leading-5 text-muted-foreground">This account can change roles, update public room context, and permanently remove room history.</div></div></div>
          )}
        </main>
      </div>
      {pendingRole && <AdminConfirmDialog title={`Change role for ${pendingRole.label}?`} description={`${pendingRole.label} will become ${pendingRole.role === "admin" ? "an Admin / Developer" : pendingRole.role.replace("_", " ")}. Platform roles are enforced on the server.`} confirmLabel={`set ${pendingRole.role === "admin" ? "admin / developer" : pendingRole.role.replace("_", " ")}`} destructive={pendingRole.role === "member"} working={working} onConfirm={() => void updateRole()} onCancel={() => setPendingRole(null)} />}
      {pendingClear && <AdminConfirmDialog title={`Clear ${pendingClear.name} history?`} description="This permanently deletes every message in this channel. The room and its members remain, but the conversation cannot be restored." confirmLabel="clear history" destructive working={working} onConfirm={() => void clearHistory()} onCancel={() => setPendingClear(null)} />}
    </div>
  );
}

type PermissionSnapshot = {
  role: string;
  permissions: string[];
  assignments: Array<{ id: number; role: string; scopeType: string; communityId: number | null; categoryId: number | null; channelId: number | null }>;
};
type CommunitySummary = {
  id: number;
  name: string;
  slug: string;
  description: string;
  rules: string;
  businessType: string;
  services: string;
  serviceArea: string;
  businessHours: string;
  contactEmail: string;
  contactPhone: string;
  onboardingStep: number;
  status: string;
  joined: boolean;
  canManage: boolean;
};
type CommunityDetail = {
  community: CommunitySummary;
  members: Array<{ id: string; username: string; displayName: string; status: string; joinedAt: string }>;
  categories: Array<{ id: number; name: string; description: string }>;
  channels: Array<{ id: number; name: string; topic: string; description: string; categoryId: number | null }>;
  assignments: Array<{ id: number; userId: string; role: string; scopeType: string; communityId: number | null }>;
  announcements: Array<{ id: number; body: string; author: string; createdAt: string }>;
  canManage: boolean;
};

function CommunityConsole() {
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [communities, setCommunities] = useState<CommunitySummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CommunityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newCommunityOpen, setNewCommunityOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newRules, setNewRules] = useState("");
  const [newServices, setNewServices] = useState("");
  const [newServiceArea, setNewServiceArea] = useState("");
  const [newBusinessHours, setNewBusinessHours] = useState("");
  const [newContactEmail, setNewContactEmail] = useState("");
  const [newContactPhone, setNewContactPhone] = useState("");
  const [settings, setSettings] = useState({
    name: "",
    description: "",
    rules: "",
    services: "",
    serviceArea: "",
    businessHours: "",
    contactEmail: "",
    contactPhone: "",
  });
  const [announcement, setAnnouncement] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryDescription, setNewCategoryDescription] = useState("");
  const [newWorkspaceChannelName, setNewWorkspaceChannelName] = useState("");
  const [newWorkspaceChannelTopic, setNewWorkspaceChannelTopic] = useState("");
  const [newWorkspaceChannelDescription, setNewWorkspaceChannelDescription] = useState("");
  const [newWorkspaceChannelCategoryId, setNewWorkspaceChannelCategoryId] = useState("");

  const loadCommunities = async () => {
    const [nextPermissions, nextCommunities] = await Promise.all([
      api<PermissionSnapshot>("/permissions/me"),
      api<CommunitySummary[]>("/communities"),
    ]);
    setPermissions(nextPermissions);
    setCommunities(nextCommunities);
    setSelectedId((current) => current ?? nextCommunities[0]?.id ?? null);
  };
  const loadDetail = async (id: number) => {
    const next = await api<CommunityDetail>(`/communities/${id}`);
    setDetail(next);
    setSettings({
      name: next.community.name,
      description: next.community.description,
      rules: next.community.rules,
      services: next.community.services,
      serviceArea: next.community.serviceArea,
      businessHours: next.community.businessHours,
      contactEmail: next.community.contactEmail,
      contactPhone: next.community.contactPhone,
    });
  };
  useEffect(() => {
    loadCommunities().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load communities")).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    loadDetail(selectedId).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load community"));
  }, [selectedId]);
  const createCommunity = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    try {
      const created = await api<CommunitySummary>("/communities", { method: "POST", body: JSON.stringify({
        name: newName,
        description: newDescription,
        rules: newRules,
        services: newServices,
        serviceArea: newServiceArea,
        businessHours: newBusinessHours,
        contactEmail: newContactEmail,
        contactPhone: newContactPhone,
      }) });
      setNewCommunityOpen(false);
      setNewName("");
      setNewDescription("");
      setNewRules("");
      setNewServices("");
      setNewServiceArea("");
      setNewBusinessHours("");
      setNewContactEmail("");
      setNewContactPhone("");
      setNotice("Business workspace created with default operating channels.");
      await loadCommunities();
      setSelectedId(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create community");
    } finally {
      setWorking(false);
    }
  };
  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}`, { method: "PATCH", body: JSON.stringify(settings) });
       setNotice("Business workspace settings saved.");
      await loadDetail(detail.community.id);
      await loadCommunities();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save community settings");
    } finally {
      setWorking(false);
    }
  };
  const changeMemberRole = async (memberId: string, role: string) => {
    if (!detail) return;
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/members/${memberId}/role`, { method: "PATCH", body: JSON.stringify({ role }) });
      setNotice("Community role updated.");
      await loadDetail(detail.community.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update member role");
    } finally {
      setWorking(false);
    }
  };
  const createCategory = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/categories`, { method: "POST", body: JSON.stringify({ name: newCategoryName, description: newCategoryDescription }) });
      setNewCategoryName("");
      setNewCategoryDescription("");
      setNotice("Category created.");
      await loadDetail(detail.community.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create category");
    } finally {
      setWorking(false);
    }
  };
  const createWorkspaceChannel = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/channels`, {
        method: "POST",
        body: JSON.stringify({
          name: newWorkspaceChannelName,
          topic: newWorkspaceChannelTopic,
          description: newWorkspaceChannelDescription,
          categoryId: newWorkspaceChannelCategoryId || null,
        }),
      });
      setNewWorkspaceChannelName("");
      setNewWorkspaceChannelTopic("");
      setNewWorkspaceChannelDescription("");
      setNewWorkspaceChannelCategoryId("");
      setNotice("Channel created in the selected category.");
      await loadDetail(detail.community.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create channel");
    } finally {
      setWorking(false);
    }
  };
  const sendAnnouncement = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/announcements`, { method: "POST", body: JSON.stringify({ body: announcement }) });
      setAnnouncement("");
      setNotice("Announcement sent to community members.");
      await loadDetail(detail.community.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send announcement");
    } finally {
      setWorking(false);
    }
  };
  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-background font-mono text-sm text-muted-foreground">loading communities…</div>;
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b border-border bg-card/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-10">
          <div><p className="font-mono text-sm font-bold">relay / business workspaces</p><p className="font-mono text-[9px] uppercase tracking-[.18em] text-muted-foreground">private business operations</p></div>
          <div className="flex items-center gap-2"><span className="rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary">{permissions?.role === "admin" ? "admin / developer" : permissions?.role?.replace("_", " ")}</span><a href={`${basePath}/chat`} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:bg-muted">back to chat</a></div>
        </div>
      </header>
      <main className="mx-auto grid max-w-7xl gap-5 px-5 py-8 lg:grid-cols-[250px_1fr] sm:px-10">
        <aside className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-center justify-between px-2 py-2"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">your businesses</p><button onClick={() => setNewCommunityOpen(true)} className="rounded bg-primary px-2 py-1 font-mono text-[9px] font-bold text-primary-foreground">new</button></div>
          <div className="mt-2 space-y-1">{communities.map((community) => <button key={community.id} onClick={() => setSelectedId(community.id)} className={`w-full rounded-md px-3 py-2 text-left font-mono text-xs ${selectedId === community.id ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted"}`}><span className="block truncate">{community.name}</span><span className="mt-1 block text-[9px] opacity-70">{community.canManage ? "business access" : community.joined ? "team member" : "available"}</span></button>)}{communities.length === 0 && <p className="px-2 py-6 font-mono text-[10px] text-muted-foreground">No business workspaces yet.</p>}</div>
        </aside>
        <section className="min-w-0">
          {error && <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive"><AlertTriangle className="h-4 w-4" />{error}<button onClick={() => setError("")} className="ml-auto"><X className="h-3.5 w-3.5" /></button></div>}
          {notice && <div className="mb-4 flex items-center gap-2 rounded-md border border-chart-4/30 bg-chart-4/10 p-3 font-mono text-xs text-chart-4"><CheckCircle2 className="h-4 w-4" />{notice}<button onClick={() => setNotice("")} className="ml-auto"><X className="h-3.5 w-3.5" /></button></div>}
          {!detail ? <div className="rounded-xl border border-border bg-card p-8"><Users className="h-6 w-6 text-primary" /><h1 className="mt-5 font-mono text-2xl font-bold">Choose a business.</h1><p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">Business owners and managers operate only inside assigned private workspaces. Platform settings stay with Admin / Developer accounts.</p></div> : <div className="space-y-5">
            <div className="rounded-xl border border-border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">business workspace</p><h1 className="mt-2 font-mono text-2xl font-bold">{detail.community.name}</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{detail.community.description || "No business description yet."}</p></div><span className="rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary">{detail.canManage ? "manage access" : "read access"}</span></div></div>
            {detail.canManage && <div className="grid gap-5 xl:grid-cols-2">
              <form onSubmit={saveSettings} className="rounded-xl border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">business settings</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Only assignments matching this workspace can change these values.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><input value={settings.name} onChange={(event) => setSettings({ ...settings, name: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="business name" /><input value={settings.contactEmail} onChange={(event) => setSettings({ ...settings, contactEmail: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="contact email" /><input value={settings.contactPhone} onChange={(event) => setSettings({ ...settings, contactPhone: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="contact phone" /><input value={settings.serviceArea} onChange={(event) => setSettings({ ...settings, serviceArea: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="service area" /><input value={settings.services} onChange={(event) => setSettings({ ...settings, services: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs sm:col-span-2" placeholder="services offered" /><input value={settings.businessHours} onChange={(event) => setSettings({ ...settings, businessHours: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs sm:col-span-2" placeholder="business hours" /><input value={settings.description} onChange={(event) => setSettings({ ...settings, description: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs sm:col-span-2" placeholder="description" /><textarea value={settings.rules} onChange={(event) => setSettings({ ...settings, rules: event.target.value })} className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs sm:col-span-2" placeholder="policies and operating rules" /></div><button disabled={working} className="mt-4 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">save business settings</button></form>
              <form onSubmit={sendAnnouncement} className="rounded-xl border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">team announcement</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Send a visible notification to current business members.</p><textarea required value={announcement} onChange={(event) => setAnnouncement(event.target.value)} className="mt-4 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder="Write a short announcement" /><button disabled={working} className="mt-4 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">send announcement</button></form>
            </div>}
            <div className="grid gap-5 xl:grid-cols-2">
              <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">team members</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{detail.members.length} people in this workspace</p></div><div className="divide-y divide-border">{detail.members.map((member) => { const assignment = detail.assignments.find((item) => item.userId === member.id && item.scopeType === "community"); const role = assignment?.role ?? "member"; return <div key={member.id} className="flex items-center gap-3 px-5 py-3"><div className={`h-2 w-2 rounded-full ${member.status === "online" ? "bg-chart-4" : "bg-muted-foreground/40"}`} /><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs">{member.displayName}</p><p className="font-mono text-[10px] text-muted-foreground">@{member.username}</p></div><span className="font-mono text-[9px] uppercase text-muted-foreground">{role.replaceAll("_", " ")}</span>{detail.canManage && <select disabled={working} value={role} onChange={(event) => void changeMemberRole(member.id, event.target.value)} className="rounded border border-border bg-background px-2 py-1 font-mono text-[9px]"><option value="member">member</option><option value="business_manager">business manager</option><option value="employee">employee</option><option value="contractor">contractor</option><option value="business_owner">business owner</option><option value="community_admin">legacy community admin</option><option value="moderator">moderator</option></select>}</div>; })}</div></section>
               <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">categories & channels</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Scoped rooms in this community</p></div><div className="border-b border-border p-5"><div className="space-y-2">{detail.categories.map((category) => <div key={category.id} className="flex items-center justify-between gap-3"><div><p className="font-mono text-xs text-secondary-foreground">{category.name}</p><p className="text-[10px] text-muted-foreground">{category.description || "No description"}</p></div><span className="font-mono text-[9px] text-muted-foreground">{detail.channels.filter((channel) => channel.categoryId === category.id).length} rooms</span></div>)}{detail.categories.length === 0 && <p className="font-mono text-[10px] text-muted-foreground">No categories yet.</p>}</div>{detail.canManage && <form onSubmit={createCategory} className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4"><input required value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="new category" className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-[10px]" /><input value={newCategoryDescription} onChange={(event) => setNewCategoryDescription(event.target.value)} placeholder="description" className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-[10px]" /><button disabled={working} className="rounded bg-primary px-2.5 py-1.5 font-mono text-[9px] font-bold text-primary-foreground disabled:opacity-50">add category</button></form>}</div><div className="divide-y divide-border">{detail.channels.map((channel) => <div key={channel.id} className="px-5 py-3"><p className="font-mono text-xs text-secondary-foreground">{channel.name}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">{channel.topic || "No topic set"}</p></div>)}{detail.channels.length === 0 && <EmptyAdminState label="No channels in this community yet." />}</div></section>
            </div>
          </div>}
        </section>
      </main>
      {newCommunityOpen && <Overlay title="Set up a business workspace" onClose={() => setNewCommunityOpen(false)}><form onSubmit={createCommunity} className="space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">business name</span><input autoFocus required value={newName} onChange={(event) => setNewName(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">description</span><input value={newDescription} onChange={(event) => setNewDescription(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">services</span><input value={newServices} onChange={(event) => setNewServices(event.target.value)} placeholder="HVAC, plumbing, electrical" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">service area</span><input value={newServiceArea} onChange={(event) => setNewServiceArea(event.target.value)} placeholder="Chicago and suburbs" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">contact email</span><input type="email" value={newContactEmail} onChange={(event) => setNewContactEmail(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">contact phone</span><input value={newContactPhone} onChange={(event) => setNewContactPhone(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label></div><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">business hours</span><input value={newBusinessHours} onChange={(event) => setNewBusinessHours(event.target.value)} placeholder="Mon–Fri, 8am–5pm" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">policies and rules</span><textarea value={newRules} onChange={(event) => setNewRules(event.target.value)} className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" /></label><button disabled={working} className="w-full rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground disabled:opacity-50">create business workspace</button></form></Overlay>}
    </div>
  );
}

function AuthRoutes() {
  return <Switch><Route path="/"><Show when="signed-in"><Redirect to="/chat" /></Show><Show when="signed-out"><Landing /></Show></Route><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/chat"><Show when="signed-in"><ChatApp /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route path="/communities"><Show when="signed-in"><CommunityConsole /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route path="/admin"><Show when="signed-in"><AdminConsole /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route component={Landing} /></Switch>;
}

function SignInPage() { return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} forceRedirectUrl={`${basePath}/chat`} fallbackRedirectUrl={`${basePath}/chat`} /></div>; }
function SignUpPage() { return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} forceRedirectUrl={`${basePath}/chat`} fallbackRedirectUrl={`${basePath}/chat`} /></div>; }

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: { logoPlacement: "inside" as const, logoLinkUrl: basePath || "/", logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
  variables: { colorPrimary: "#f5b544", colorForeground: "#f8f1df", colorMutedForeground: "#94a0ae", colorDanger: "#ff7b72", colorBackground: "#171e2b", colorInput: "#101722", colorInputForeground: "#f8f1df", colorNeutral: "#2a3444", fontFamily: "Space Mono, monospace", borderRadius: "0.65rem" },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#171e2b] rounded-2xl w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "!text-[#f8f1df]",
    headerSubtitle: "!text-[#94a0ae]",
    socialButtonsBlockButtonText: "!text-[#f8f1df]",
    formFieldLabel: "!text-[#f8f1df]",
    footerActionLink: "!text-[#f5b544]",
    footerActionText: "!text-[#94a0ae]",
    dividerText: "!text-[#94a0ae]",
    identityPreviewEditButton: "!text-[#f5b544]",
    formFieldSuccessText: "!text-[#55c2a0]",
    alertText: "!text-[#ffb4ae]",
    logoBox: "mb-5",
    logoImage: "max-h-10",
    socialButtonsBlockButton: "!border-[#2a3444] !bg-[#101722]",
    formButtonPrimary: "!bg-[#f5b544] !text-[#101722]",
    formFieldInput: "!border-[#2a3444] !bg-[#101722] !text-[#f8f1df]",
    footerAction: "!bg-transparent",
    dividerLine: "!bg-[#2a3444]",
    alert: "!border-[#ff7b72]/40 !bg-[#ff7b72]/10",
    otpCodeFieldInput: "!border-[#2a3444] !bg-[#101722] !text-[#f8f1df]",
    formFieldRow: "mb-4",
    main: "gap-4",
  },
};

function ClerkShell() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} routerPush={(to) => setLocation(to.replace(basePath, "") || "/")} routerReplace={(to) => setLocation(to.replace(basePath, "") || "/")} localization={{ signIn: { start: { title: "Welcome back", subtitle: "Return to your rooms and conversations" } }, signUp: { start: { title: "Create your relay account", subtitle: "Find your people and make a room" } } }}><QueryClientProvider client={queryClient}><AuthRoutes /></QueryClientProvider></ClerkProvider>;
}

function App() {
  if (!clerkPubKey) return <div className="flex min-h-[100dvh] items-center justify-center bg-background font-mono text-sm text-destructive">Authentication is not configured.</div>;
  return <WouterRouter base={basePath}><ErrorBoundary><ClerkShell /></ErrorBoundary></WouterRouter>;
}

export default App;