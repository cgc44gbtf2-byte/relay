import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Megaphone,
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
  useSession,
  useUser,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { mergeRefreshedMessages, upsertBoundedMessageGroup, upsertMessage } from "./message-state";
import { Route, Router as WouterRouter, Switch, Redirect, useLocation, useRoute } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";
import { clearTestAccountReturnContext, readTestAccountReturnContext, writeTestAccountReturnContext } from "./test-account-switch";

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const notificationCategoryLabels: Record<Notification["category"], string> = {
  direct_message: "Direct messages",
  mention: "Mentions",
  task_assigned: "Tasks assigned",
  task_updated: "Task updates",
  task_deadline: "Task deadlines",
  announcement: "Announcements",
  document_acknowledgement: "Document acknowledgments",
  join_request: "Join requests",
  report: "Reports",
  administrative_action: "Administrative actions",
  general: "Other",
};
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
  isTestAccount?: boolean;
  testRole?: string | null;
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
  replyToId?: string | null;
  sender: Profile | null;
  recipientId?: string | null;
  deletedAt?: string | null;
  attachments?: Array<{ id: number; fileName: string; contentType: string; fileSize: number; url: string }>;
  reactions?: Array<{ emoji: string; count: number; reacted: boolean }>;
};
type Member = Profile & { role: string; mutedUntil?: string | null };
type JoinRequest = { id: number; status: string; createdAt: string; user: Profile };
type Notification = {
  id: number;
  type: string;
  category: "direct_message" | "mention" | "task_assigned" | "task_updated" | "task_deadline" | "announcement" | "document_acknowledgement" | "join_request" | "report" | "administrative_action" | "general";
  body: string;
  communityId?: number | null;
  entityType?: string | null;
  entityId?: string | null;
  actionUrl?: string | null;
  readAt?: string | null;
  createdAt: string;
};
type AppConfig = {
  siteName: string;
  landingEyebrow: string;
  landingTitle: string;
  landingDescription: string;
  networkStatusLabel: string;
};
type DeveloperRelease = {
  id: number;
  version: string;
  title: string;
  notes: string;
  status: "draft" | "review" | "published" | "archived";
  announcementId?: number | null;
  createdAt: string;
  reviewedAt?: string | null;
  publishedAt?: string | null;
};
const defaultAppConfig: AppConfig = {
  siteName: "relay",
  landingEyebrow: "a quieter kind of social",
  landingTitle: "Real rooms.\nReal presence.",
  landingDescription: "Relay brings the immediacy of IRC to the browser, with public channels, direct messages, profiles, and the tools communities need to stay kind.",
  networkStatusLabel: "live and open",
};

const landingFeatureGroups: Array<{
  label: string;
  title: string;
  description: string;
  icon: LucideIcon;
  features: Array<{ title: string; description: string; icon: LucideIcon }>;
}> = [
  {
    label: "business features",
    title: "Keep the whole operation in the room.",
    description: "Give managers one workspace for people, work, communication, and the records that keep a business moving.",
    icon: LayoutDashboard,
    features: [
      { title: "Workspace operations", description: "Organize employees by departments, locations, teams, and roles.", icon: Users },
      { title: "Work that stays visible", description: "Assign tasks, publish announcements, share documents, and manage policies.", icon: CheckCircle2 },
      { title: "Permission with context", description: "Control access with workspace roles, private channels, and scoped permissions.", icon: Shield },
      { title: "Audit-ready activity", description: "Review named actors, actions, resources, and date-filtered business history.", icon: Activity },
    ],
  },
  {
    label: "developer features",
    title: "Build on a live communication layer.",
    description: "Use the same platform primitives for fast product work, reliable operations, and controlled releases.",
    icon: Radio,
    features: [
      { title: "Real-time by default", description: "Channels, direct messages, presence, typing, reactions, and file sharing update live.", icon: Radio },
      { title: "Workspace-scoped APIs", description: "Work with authenticated routes and business data that stays isolated by workspace.", icon: Database },
      { title: "Operational control", description: "Manage permissions, moderation, health checks, and platform activity from one console.", icon: Settings },
      { title: "Release visibility", description: "Track developer releases, review status, publish updates, and keep change history clear.", icon: Zap },
    ],
  },
];

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
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
  if (!response.ok) throw new ApiError(data.error ?? "Something went wrong", response.status, data.code);
  return data as T;
}

function isMissingChannelError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "CHANNEL_NOT_FOUND";
}

function preferredChannel(channels: Channel[]): Channel | null {
  return channels.find((channel) => channel.joined)
    ?? channels.find((channel) => !channel.isPrivate && channel.accessStatus !== "pending")
    ?? null;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const activityDateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function timeLabel(value: string): string {
  return timeFormatter.format(new Date(value));
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
  const [config, setConfig] = useState<AppConfig>(defaultAppConfig);
  useEffect(() => {
    api<AppConfig>("/app-config").then(setConfig).catch(() => undefined);
  }, []);
  const titleLines = config.landingTitle.split("\n");
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Hash className="h-5 w-5" /></div>
          <div><p className="font-mono font-bold">{config.siteName}</p><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">internet relay chat</p></div>
        </div>
        <div className="flex gap-2">
          <a className="rounded-lg border border-border px-4 py-2 font-mono text-xs hover:bg-muted" href={`${basePath}/sign-in`}>sign in</a>
          <a className="rounded-lg bg-primary px-4 py-2 font-mono text-xs font-bold text-primary-foreground hover:brightness-105" href={`${basePath}/sign-up`}>create account</a>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 pb-20 pt-16">
        <div className="grid gap-12 lg:grid-cols-[1.1fr_.9fr] lg:items-center">
          <div>
            <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.2em] text-primary">{config.landingEyebrow}</p>
            <h1 className="max-w-3xl font-mono text-4xl font-bold leading-[1.1] sm:text-6xl">{titleLines.map((line, index) => <span key={`${line}-${index}`} className={index === titleLines.length - 1 ? "block text-secondary-foreground" : "block"}>{line}</span>)}</h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">{config.landingDescription}</p>
            <div className="mt-8 flex flex-wrap gap-3"><a className="rounded-lg bg-primary px-5 py-3 font-mono text-sm font-bold text-primary-foreground" href={`${basePath}/sign-up`}>join the network <Zap className="ml-2 inline h-4 w-4" /></a><span className="flex items-center gap-2 rounded-lg border border-border px-4 py-3 font-mono text-xs text-muted-foreground"><span className="h-2 w-2 rounded-full bg-chart-4" /> {config.networkStatusLabel}</span></div>
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
        </div>
        <section aria-labelledby="features-heading" className="mt-24">
          <div className="max-w-2xl">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">one relay, two ways to work</p>
            <h2 id="features-heading" className="mt-3 font-mono text-3xl font-bold sm:text-4xl">Features for the people who use Relay and the people who build it.</h2>
          </div>
          <div className="mt-10 grid gap-5 lg:grid-cols-2">
            {landingFeatureGroups.map((group) => {
              const GroupIcon = group.icon;
              return <article key={group.label} className="rounded-2xl border border-border bg-card/70 p-6 shadow-lg sm:p-7">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">{group.label}</p>
                    <h3 className="mt-3 font-mono text-xl font-bold leading-tight">{group.title}</h3>
                  </div>
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"><GroupIcon className="h-5 w-5" /></div>
                </div>
                <p className="mt-4 text-sm leading-6 text-muted-foreground">{group.description}</p>
                <div className="mt-6 space-y-4 border-t border-border pt-5">
                  {group.features.map((feature) => {
                    const FeatureIcon = feature.icon;
                    return <div key={feature.title} className="flex gap-3">
                      <FeatureIcon className="mt-0.5 h-4 w-4 shrink-0 text-secondary-foreground" />
                      <div>
                        <h4 className="font-mono text-xs font-bold">{feature.title}</h4>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{feature.description}</p>
                      </div>
                    </div>;
                  })}
                </div>
              </article>;
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

function PreviewMessage({ name, text, color }: { name: string; text: string; color: string }) {
  return <div className="flex gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-md font-mono text-[10px] font-bold text-background" style={{ backgroundColor: color }}>{initials(name)}</div><div><div className="font-mono text-xs font-bold" style={{ color }}>{name} <span className="ml-2 text-[10px] font-normal text-muted-foreground">03:14 PM</span></div><p className="mt-1 text-sm text-foreground/85">{text}</p></div></div>;
}

const MessageRow = memo(function MessageRow({
  message,
  currentUserId,
  onDelete,
  onToggleReaction,
}: {
  message: ChatMessage;
  currentUserId: string;
  onDelete: (message: ChatMessage) => void;
  onToggleReaction: (message: ChatMessage, emoji: string) => void;
}) {
  return <div className={`group flex gap-3 ${message.kind === "system" ? "opacity-65" : ""}`}>
    <Avatar user={message.sender} size="sm" />
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs font-bold text-secondary-foreground">{message.sender?.displayName ?? "system"}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{timeLabel(message.createdAt)}</span>
        {message.sender?.id === currentUserId && message.kind !== "deleted" && <button onClick={() => onDelete(message)} className="ml-auto hidden font-mono text-[10px] text-muted-foreground hover:text-destructive group-hover:block">delete</button>}
      </div>
      <p className={`mt-1 break-words text-sm leading-6 ${message.kind === "deleted" ? "italic text-muted-foreground" : "text-foreground/90"}`}>{message.body}</p>
      {message.attachments?.map((attachment) => <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="mt-2 flex max-w-xs items-center gap-2 rounded border border-border bg-muted/40 px-2.5 py-2 font-mono text-[10px] text-primary hover:border-primary"><Paperclip className="h-3.5 w-3.5" /><span className="truncate">{attachment.fileName}</span><span className="text-muted-foreground">{Math.ceil(attachment.fileSize / 1024)}kb</span></a>)}
      {message.kind !== "deleted" && <div className="mt-2 flex items-center gap-1">{["👍", "❤️", "🎉"].map((emoji) => {
        const reaction = message.reactions?.find((item) => item.emoji === emoji);
        return <button key={emoji} onClick={() => onToggleReaction(message, emoji)} className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${reaction?.reacted ? "border-primary bg-primary/10" : "border-transparent bg-muted/40 hover:border-border"}`}>{emoji}{reaction?.count ? ` ${reaction.count}` : ""}</button>;
      })}</div>}
    </div>
  </div>;
});

function useRoomData(channelId: number | null, activeDm: Profile | null, onMissingChannel?: (channelId: number) => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState("");
  const onMissingChannelRef = useRef(onMissingChannel);
  const messageRefreshRef = useRef(0);
  const messagesRef = useRef(messages);
  const messageVersionRef = useRef(0);
  const changedMessagesRef = useRef(new Map<string, { version: number; message: ChatMessage }>());
  const roomKey = activeDm ? `dm:${activeDm.id}` : channelId ? `channel:${channelId}` : "none";
  const roomKeyRef = useRef(roomKey);
  onMissingChannelRef.current = onMissingChannel;
  messagesRef.current = messages;

  const updateMessages = useCallback((updater: ChatMessage[] | ((items: ChatMessage[]) => ChatMessage[])) => {
    setMessages((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      const currentById = new Map(current.map((message) => [message.id, message]));
      const version = messageVersionRef.current + 1;
      let changed = false;
      for (const message of next) {
        if (currentById.get(message.id) !== message) {
          changedMessagesRef.current.set(message.id, { version, message });
          changed = true;
        }
      }
      if (changed) messageVersionRef.current = version;
      return next;
    });
  }, []);

  const refreshMessages = useCallback(async (showLoading = false) => {
    const refreshId = ++messageRefreshRef.current;
    const refreshRoomKey = roomKey;
    const startVersion = messageVersionRef.current;
    const messagesAtStart = messagesRef.current;
    if (showLoading) setLoading(true);
    if (!channelId && !activeDm) {
      setMessages([]);
      setHasOlder(false);
      if (showLoading) setLoading(false);
      return;
    }
    const promise = activeDm
      ? api<{ messages: ChatMessage[] }>(`/dm/${activeDm.id}/messages`)
      : api<{ messages: ChatMessage[] }>(`/channels/${channelId}/messages`);
    try {
      const data = await promise;
      if (refreshId === messageRefreshRef.current && roomKeyRef.current === refreshRoomKey) {
        const changedDuringRefresh = [...changedMessagesRef.current.values()]
          .filter(({ version }) => version > startVersion)
          .map(({ message }) => message);
        const preservedHistory = activeDm
          ? messagesAtStart.filter((message) => !data.messages.some(({ id }) => id === message.id))
          : [];
        setMessages(mergeRefreshedMessages(
          data.messages,
          changedDuringRefresh,
          preservedHistory,
          activeDm ? Number.POSITIVE_INFINITY : 100,
        ));
        for (const [id, change] of changedMessagesRef.current) {
          if (change.version <= startVersion) changedMessagesRef.current.delete(id);
        }
        setHasOlder(Boolean(activeDm && data.messages.length === 100));
      }
    } catch (error) {
      if (refreshId !== messageRefreshRef.current) return;
      setMessages([]);
      if (channelId && !activeDm && isMissingChannelError(error)) onMissingChannelRef.current?.(channelId);
    } finally {
      if (showLoading && refreshId === messageRefreshRef.current) setLoading(false);
    }
  }, [activeDm, channelId, roomKey]);

  const loadOlderMessages = useCallback(async () => {
    if (!activeDm || loadingOlder || !hasOlder || messages.length === 0) return;
    const paginationRoomKey = roomKey;
    setOlderMessagesError("");
    setLoadingOlder(true);
    try {
      const cursor = encodeURIComponent(messages[0].createdAt);
      const data = await api<{ messages: ChatMessage[] }>(`/dm/${activeDm.id}/messages?before=${cursor}`);
      if (roomKeyRef.current !== paginationRoomKey) return;
      updateMessages((items) => {
        const existing = new Set(items.map((item) => item.id));
        return [...data.messages.filter((item) => !existing.has(item.id)), ...items];
      });
      setHasOlder(data.messages.length === 100);
    } catch {
      if (roomKeyRef.current === paginationRoomKey) {
        setOlderMessagesError("Older messages could not be loaded.");
      }
    } finally {
      if (roomKeyRef.current === paginationRoomKey) setLoadingOlder(false);
    }
  }, [activeDm, hasOlder, loadingOlder, messages, roomKey, updateMessages]);

  useEffect(() => {
    roomKeyRef.current = roomKey;
    messageVersionRef.current = 0;
    changedMessagesRef.current.clear();
    messagesRef.current = [];
    setMessages([]);
    setMembers([]);
    setHasOlder(false);
    setLoadingOlder(false);
    setOlderMessagesError("");
    if (!channelId && !activeDm) {
      setLoading(false);
      return;
    }
    void refreshMessages(true);
    let cancelled = false;
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
  }, [channelId, activeDm, refreshMessages, roomKey]);
  return { messages, setMessages: updateMessages, members, setMembers, loading, loadingOlder, hasOlder, olderMessagesError, loadOlderMessages, refreshMessages };
}

function ChatApp() {
  const { user } = useUser();
  const { signOut, client, setActive } = useClerk();
  const { session } = useSession();
  const [, setLocation] = useLocation();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [currentChannelId, setCurrentChannelId] = useState<number | null>(null);
  const [activeDm, setActiveDm] = useState<Profile | null>(null);
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [userResults, setUserResults] = useState<Profile[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notificationFilter, setNotificationFilter] = useState<"all" | Notification["category"]>("all");
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
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [createChannelError, setCreateChannelError] = useState("");
  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryDescription, setNewCategoryDescription] = useState("");
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [showRequests, setShowRequests] = useState(false);
  const [joiningChannelId, setJoiningChannelId] = useState<number | null>(null);
  const [joinErrors, setJoinErrors] = useState<Record<number, string>>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const wsRef = useRef<WebSocket | null>(ws);
  const typingStartTimerRef = useRef<number | null>(null);
  const typingIdleTimerRef = useRef<number | null>(null);
  const typingAdvertisedRef = useRef(false);
  const [connection, setConnection] = useState("connecting");
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrapError, setBootstrapError] = useState("");
  const [returnOwnerError, setReturnOwnerError] = useState("");
  const [returningToOwner, setReturningToOwner] = useState(false);
  const [channelRefreshError, setChannelRefreshError] = useState("");
  const currentChannelIdRef = useRef<number | null>(currentChannelId);
  const activeDmIdRef = useRef<string | null>(activeDm?.id ?? null);
  const channelRefreshRef = useRef<Promise<Channel[]> | null>(null);
  const userSearchRequestRef = useRef(0);
  const profileRef = useRef<Profile | null>(profile);
  currentChannelIdRef.current = currentChannelId;
  activeDmIdRef.current = activeDm?.id ?? null;
  profileRef.current = profile;
  wsRef.current = ws;

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
  const setRoomMessages = room.setMessages;
  const currentChannel = channels.find((channel) => channel.id === currentChannelId) ?? null;
  const actorRole = room.members.find((member) => member.id === profile?.id)?.role;
  const unread = notifications.filter((notification) => !notification.readAt).length;
  const visibleNotifications = notificationFilter === "all"
    ? notifications
    : notifications.filter((notification) => notification.category === notificationFilter);

  useEffect(() => {
    if (!currentChannel || !["owner", "moderator"].includes(actorRole ?? "")) {
      setJoinRequests([]);
      return;
    }
    api<JoinRequest[]>(`/channels/${currentChannel.id}/join-requests`).then(setJoinRequests).catch(() => setJoinRequests([]));
  }, [currentChannel?.id, actorRole]);

  useEffect(() => {
    let cancelled = false;
    setBootstrapError("");
    Promise.allSettled([
      api<Profile>("/me"),
      api<Channel[]>("/channels"),
      api<Category[]>("/categories"),
      api<Notification[]>("/notifications"),
    ]).then(([meResult, channelsResult, categoriesResult, notificationsResult]) => {
      if (cancelled) return;
      if (meResult.status === "rejected" || channelsResult.status === "rejected") {
        setBootstrapError("Relay could not load your workspace.");
        return;
      }
      const me = meResult.value;
      const list = channelsResult.value;
      setProfile(me);
      setChannels(list);
      setCategories(categoriesResult.status === "fulfilled" ? categoriesResult.value : []);
      setNotifications(notificationsResult.status === "fulfilled" ? notificationsResult.value : []);
      const first = preferredChannel(list);
      if (first) setCurrentChannelId(first.id);
      if (first && !first.joined && !first.isPrivate) {
        api(`/channels/${first.id}/join`, { method: "POST", body: "{}" })
          .then(() => setChannels((items) => items.map((item) => item.id === first.id ? { ...item, joined: true, accessStatus: "member" } : item)))
          .catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bootstrapAttempt]);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    const connect = async () => {
      try {
        const { ticket } = await api<{ ticket: string }>("/ws-ticket");
        if (cancelled) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const connectedSocket = new WebSocket(`${protocol}//${window.location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`);
        socket = connectedSocket;
        connectedSocket.onopen = () => {
          reconnectAttempt = 0;
          setConnection("live");
          setWs(connectedSocket);
          if (currentChannelId && !activeDm) {
            connectedSocket.send(JSON.stringify({ type: "subscribe", channelId: currentChannelId }));
          }
          if (currentChannelId || activeDm) void room.refreshMessages();
        };
        connectedSocket.onclose = () => {
          if (cancelled) return;
          setConnection("offline");
          setWs((current) => current === connectedSocket ? null : current);
          const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt) + Math.floor(Math.random() * 250);
          reconnectAttempt += 1;
          reconnectTimer = window.setTimeout(() => void connect(), delay);
        };
        connectedSocket.onerror = () => setConnection("offline");
        connectedSocket.onmessage = (event) => {
        try {
           if (cancelled) return;
           const data = JSON.parse(event.data) as { type: string; eventId?: string; occurredAt?: string; channelId?: number; message?: ChatMessage; channel?: Channel; action?: string; user?: Profile; userId?: string; messageId?: string; notificationId?: number; readAt?: string; reactions?: ChatMessage["reactions"]; notification?: Notification };
           if (data.type === "message" && data.message?.channelId === currentChannelIdRef.current && !activeDmIdRef.current) room.setMessages((items) => upsertMessage(items, data.message!));
           if (data.type === "notification" && data.notification) setNotifications((items) => items.some((item) => item.id === data.notification!.id) ? items : [data.notification!, ...items].slice(0, 100));
           if (data.type === "notification_read" && Number.isInteger(data.notificationId)) setNotifications((items) => items.map((item) => item.id === data.notificationId ? { ...item, readAt: typeof data.readAt === "string" ? data.readAt : new Date().toISOString() } : item));
          if (data.type === "dm" && data.message && activeDm && (data.message.sender?.id === activeDm.id || data.message.recipientId === activeDm.id)) room.setMessages((items) => upsertMessage(items, data.message!));
          if (data.type === "channel" && data.channel) setChannels((items) => items.map((item) => item.id === data.channel!.id ? { ...item, ...data.channel } : item));
          if (data.type === "channel_removed" && Number.isInteger(data.channelId)) {
            setChannels((items) => items.filter((item) => item.id !== data.channelId));
            if (currentChannelIdRef.current === data.channelId) void recoverFromMissingChannel(data.channelId);
          }
           if (
             data.type === "typing" &&
             data.channelId === currentChannelIdRef.current &&
             !activeDmIdRef.current &&
             data.userId &&
             data.userId !== profileRef.current?.id
           ) {
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
           if (
             data.type === "presence"
             && data.channelId === currentChannelIdRef.current
             && !activeDmIdRef.current
           ) {
             api<Member[]>(`/channels/${currentChannelIdRef.current}/members`).then(room.setMembers).catch(() => undefined);
             const presenceUser = data.user?.displayName ?? "Someone";
             const presenceId = data.eventId
               ?? `${data.channelId}-${data.user?.id ?? data.userId ?? "unknown"}-${data.action ?? "changed"}`;
             room.setMessages((items) => upsertBoundedMessageGroup(items, {
               id: `presence-${presenceId}`,
               body: `${presenceUser} ${data.action === "join" ? "joined" : "left"} the room`,
               kind: "system",
               createdAt: data.occurredAt ?? new Date().toISOString(),
               sender: null,
               channelId: currentChannelIdRef.current,
             }, (message) => message.id.startsWith("presence-"), 20));
          }
        } catch { /* ignore malformed frames */ }
        };
      } catch {
        if (cancelled) return;
        setConnection("offline");
        const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt) + Math.floor(Math.random() * 250);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(() => void connect(), delay);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      const closingSocket = socket;
      if (closingSocket?.readyState === WebSocket.OPEN || closingSocket?.readyState === WebSocket.CONNECTING) {
        if (closingSocket.readyState === WebSocket.OPEN && currentChannelId !== null && !activeDm) {
          closingSocket.send(JSON.stringify({ type: "unsubscribe", channelId: currentChannelId }));
        }
        closingSocket.close();
        setWs((current) => current === closingSocket ? null : current);
      }
    };
  }, [currentChannelId, activeDm, room.refreshMessages]);

  useEffect(() => {
    setTypingUsers({});
  }, [currentChannelId, activeDm]);

  useEffect(() => {
    const requestId = ++userSearchRequestRef.current;
    const query = userSearch.trim();
    if (query.length < 2) {
      setUserResults([]);
      return () => {
        if (userSearchRequestRef.current === requestId) userSearchRequestRef.current += 1;
      };
    }
    const timer = window.setTimeout(() => {
      api<Profile[]>(`/users/search?q=${encodeURIComponent(query)}`)
        .then((results) => {
          if (userSearchRequestRef.current === requestId) setUserResults(results);
        })
        .catch(() => {
          if (userSearchRequestRef.current === requestId) setUserResults([]);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (userSearchRequestRef.current === requestId) userSearchRequestRef.current += 1;
    };
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
    if (channelId !== null) {
      if (typingStartTimerRef.current !== null) window.clearTimeout(typingStartTimerRef.current);
      if (typingIdleTimerRef.current !== null) window.clearTimeout(typingIdleTimerRef.current);
      typingStartTimerRef.current = null;
      typingIdleTimerRef.current = null;
      if (typingAdvertisedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "typing", channelId, active: false }));
      }
      typingAdvertisedRef.current = false;
    }
    try {
      const sent = activeDm
        ? await api<ChatMessage>(`/dm/${activeDm.id}/messages`, { method: "POST", body: JSON.stringify({ body, replyToId: replyingTo?.id ?? null }) })
        : await api<ChatMessage>(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ body, replyToId: replyingTo?.id ?? null }) });
      setReplyingTo(null);
      if (activeDmIdRef.current === dmId && currentChannelIdRef.current === channelId) {
        room.setMessages((items) => upsertMessage(items, sent));
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
  useEffect(() => {
    setReplyingTo(null);
  }, [currentChannelId, activeDm?.id]);
  const sendTyping = (value: string) => {
    setDraft(value);
    const channelId = currentChannelId;
    if (!channelId || activeDm) return;
    if (typingIdleTimerRef.current !== null) window.clearTimeout(typingIdleTimerRef.current);

    if (!value.trim()) {
      if (typingStartTimerRef.current !== null) window.clearTimeout(typingStartTimerRef.current);
      typingStartTimerRef.current = null;
      typingIdleTimerRef.current = null;
      if (typingAdvertisedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "typing", channelId, active: false }));
      }
      typingAdvertisedRef.current = false;
      return;
    }

    if (!typingAdvertisedRef.current && typingStartTimerRef.current === null) {
      typingStartTimerRef.current = window.setTimeout(() => {
        typingStartTimerRef.current = null;
        if (
          currentChannelIdRef.current === channelId
          && !activeDmIdRef.current
          && wsRef.current?.readyState === WebSocket.OPEN
        ) {
          wsRef.current.send(JSON.stringify({ type: "typing", channelId, active: true }));
          typingAdvertisedRef.current = true;
        }
      }, 300);
    }

    typingIdleTimerRef.current = window.setTimeout(() => {
      typingIdleTimerRef.current = null;
      if (
        typingAdvertisedRef.current
        && currentChannelIdRef.current === channelId
        && !activeDmIdRef.current
        && wsRef.current?.readyState === WebSocket.OPEN
      ) {
        wsRef.current.send(JSON.stringify({ type: "typing", channelId, active: false }));
      }
      typingAdvertisedRef.current = false;
    }, 1_500);
  };
  useEffect(() => () => {
    if (typingStartTimerRef.current !== null) window.clearTimeout(typingStartTimerRef.current);
    if (typingIdleTimerRef.current !== null) window.clearTimeout(typingIdleTimerRef.current);
    typingStartTimerRef.current = null;
    typingIdleTimerRef.current = null;
    if (
      typingAdvertisedRef.current
      && currentChannelId
      && !activeDm
      && wsRef.current?.readyState === WebSocket.OPEN
    ) {
      wsRef.current.send(JSON.stringify({ type: "typing", channelId: currentChannelId, active: false }));
    }
    typingAdvertisedRef.current = false;
  }, [currentChannelId, activeDm]);
  const joinChannel = async (channel: Channel) => {
    if (joiningChannelId === channel.id) return;
    setJoiningChannelId(channel.id);
    setJoinErrors((errors) => {
      const next = { ...errors };
      delete next[channel.id];
      return next;
    });
    try {
      const result = await api<{ status: "member" | "pending" }>(`/channels/${channel.id}/join`, { method: "POST", body: "{}" });
      if (result.status === "pending") {
        setChannels((items) => items.map((item) => item.id === channel.id ? { ...item, accessStatus: "pending" } : item));
        window.alert("Join request sent. The channel owner will review it.");
        return;
      }
      setChannels((items) => items.map((item) => item.id === channel.id ? { ...item, joined: true, accessStatus: "member" } : item));
      setCurrentChannelId(channel.id);
      setActiveDm(null);
    } catch (error) {
      if (isMissingChannelError(error)) {
        try {
          await refreshChannels();
        } catch {
          setJoinErrors((errors) => ({ ...errors, [channel.id]: "The channel is no longer available." }));
        }
      } else {
        setJoinErrors((errors) => ({
          ...errors,
          [channel.id]: error instanceof Error ? error.message : "Channel could not be joined.",
        }));
      }
    } finally {
      setJoiningChannelId((joining) => joining === channel.id ? null : joining);
    }
  };
  const createChannel = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingChannel) return;
    setCreatingChannel(true);
    setCreateChannelError("");
    try {
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
      setCurrentChannelId(created.id);
      setActiveDm(null);
      setNewChannelOpen(false);
      setNewChannelName("");
      setNewChannelTopic("");
      setNewChannelDescription("");
      setNewChannelCategoryId("");
      setNewChannelPrivate(false);
      setNewChannelInviteOnly(false);
      setNewChannelPassword("");
    } catch (error) {
      setCreateChannelError(error instanceof Error ? error.message : "Channel could not be created.");
    } finally {
      setCreatingChannel(false);
    }
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
    if (!notice.readAt) {
      try {
        await api(`/notifications/${notice.id}/read`, { method: "POST", body: "{}" });
        setNotifications((items) => items.map((item) => item.id === notice.id ? { ...item, readAt: new Date().toISOString() } : item));
      } catch {
        // Opening the notification should still work if marking it read fails.
      }
    }
    setPanel(null);
    if (notice.actionUrl?.startsWith("/")) {
      setLocation(notice.actionUrl);
    }
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
  const deleteMessage = useCallback(async (message: ChatMessage) => {
    try {
      const deleted = await api<ChatMessage>(`/messages/${message.id}`, { method: "DELETE" });
      setRoomMessages((items) => items.map((item) => item.id === deleted.id ? deleted : item));
    } catch (error) { window.alert(error instanceof Error ? error.message : "Message could not be deleted"); }
  }, [setRoomMessages]);
  const toggleReaction = useCallback(async (message: ChatMessage, emoji: string) => {
    const current = message.reactions?.find((reaction) => reaction.emoji === emoji);
    try {
      const reactions = current?.reacted
        ? await api<ChatMessage["reactions"]>(`/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`, { method: "DELETE" })
        : await api<ChatMessage["reactions"]>(`/messages/${message.id}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
      setRoomMessages((items) => items.map((item) => item.id === message.id ? { ...item, reactions } : item));
    } catch (error) { window.alert(error instanceof Error ? error.message : "Reaction could not be changed"); }
  }, [setRoomMessages]);
  const sendAttachment = async (file: File) => {
    const channelId = currentChannelId;
    if (channelId === null || activeDm) return;
    if (file.size < 1 || file.size > 10_000_000) {
      window.alert("Files must be smaller than 10 MB.");
      return;
    }
    setUploading(true);
    let sentMessageId: string | null = null;
    try {
      const sent = await api<ChatMessage>(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ body: file.name }) });
      sentMessageId = sent.id;
      const upload = await api<{ uploadURL: string; objectPath: string }>("/storage/uploads/request-url", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type, resourceType: "message", resourceId: sent.id }) });
      const uploaded = await fetch(upload.uploadURL, { method: "PUT", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
      if (!uploaded.ok) throw new Error("File upload failed");
      const attachment = await api<NonNullable<ChatMessage["attachments"]>[number]>(`/messages/${sent.id}/attachments`, { method: "POST", body: JSON.stringify({ objectPath: upload.objectPath, fileName: file.name, contentType: file.type || "application/octet-stream", fileSize: file.size }) });
      if (currentChannelIdRef.current === channelId) {
        room.setMessages((items) => {
          const updated = { ...sent, attachments: [attachment] };
          return items.some((item) => item.id === sent.id)
            ? items.map((item) => item.id === sent.id ? updated : item)
            : [...items, updated];
        });
      }
    } catch (error) {
      if (sentMessageId) {
        try {
          await api(`/messages/${sentMessageId}`, { method: "DELETE" });
        } catch {
          // Preserve the original upload error if cleanup also fails.
        }
      }
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
  const returnToOwner = async () => {
    if (returningToOwner) return;
    setReturningToOwner(true);
    setReturnOwnerError("");
    try {
      const context = readTestAccountReturnContext();
      const ownerSession = context && client?.sessions?.find((item) => item.id === context.ownerSessionId);
      if (
        !context
        || !ownerSession
        || ownerSession.status !== "active"
        || ownerSession.user?.id !== context.ownerUserId
      ) {
        throw new Error("Your owner session is no longer available. Sign out and sign in again to return to the owner account.");
      }
      if (!setActive) throw new Error("Clerk session switching is unavailable.");
      await setActive({ session: context.ownerSessionId });
      clearTestAccountReturnContext();
      window.location.assign(`${basePath}/chat`);
    } catch (reason) {
      setReturnOwnerError(reason instanceof Error ? reason.message : "Could not return to the owner account.");
      setReturningToOwner(false);
    }
  };
  const renderChannel = (channel: Channel) => <div key={channel.id}><button disabled={joiningChannelId === channel.id} onClick={() => channel.joined ? (setCurrentChannelId(channel.id), setActiveDm(null)) : void joinChannel(channel)} className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left font-mono text-xs disabled:opacity-50 ${channel.id === currentChannelId && !activeDm ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"}`}><span className="flex min-w-0 items-center gap-2"><Hash className={`h-3.5 w-3.5 ${channel.isPrivate ? "text-secondary-foreground" : "text-primary/70"}`} /><span className="truncate">{channel.name.slice(1)}</span></span><span className="ml-2 text-[10px]">{joiningChannelId === channel.id ? "joining…" : channel.accessStatus === "pending" ? "…" : channel.memberCount}</span></button>{joinErrors[channel.id] && <p className="px-2 pb-1 font-mono text-[9px] leading-4 text-destructive">{joinErrors[channel.id]}</p>}</div>;
  if (!profile && bootstrapError) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background px-6 text-center font-mono">
        <p className="text-sm text-muted-foreground">{bootstrapError}</p>
        <button className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-foreground hover:bg-muted" onClick={() => setBootstrapAttempt((attempt) => attempt + 1)}>
          <RefreshCw className="h-3.5 w-3.5" />
          retry connection
        </button>
      </div>
    );
  }
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
            <div className="space-y-4">
              {channelGroups.map(({ category, channels: categoryChannels }) => <div key={category.id}><p className="mb-1 px-2 font-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground">{category.name}</p><div className="space-y-1">{categoryChannels.map(renderChannel)}</div></div>)}
              {uncategorizedChannels.length > 0 && <div><p className="mb-1 px-2 font-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground">uncategorized</p><div className="space-y-1">{uncategorizedChannels.map(renderChannel)}</div></div>}
              {visibleChannels.length === 0 && <p className="px-2 font-mono text-[10px] text-muted-foreground">No rooms match this filter.</p>}
            </div>
          <p className="mb-2 mt-7 px-2 font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">direct messages</p>
          <div className="relative"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="find a person" className="h-9 w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 pl-9 pr-3 font-mono text-[11px] outline-none focus:border-primary" /></div>
          {userResults.length > 0 && <div className="mt-2 space-y-1 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-1">{userResults.map((result) => <button key={result.id} onClick={() => { setActiveDm(result); setUserSearch(""); setUserResults([]); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-sidebar-accent"><Avatar user={result} size="sm" /><span className="min-w-0 truncate font-mono text-xs">{result.displayName}</span></button>)}</div>}
        </div>
        <button className="m-3 flex items-center gap-2 rounded-md bg-sidebar-accent/60 p-2.5 text-left" onClick={() => setPanel("profile")}><Avatar user={profile} size="sm" /><span className="min-w-0 flex-1 truncate"><span className="block font-mono text-xs">{profile.displayName}</span><span className="block font-mono text-[9px] text-muted-foreground">@{profile.username}</span>{profile.isTestAccount && <span className="mt-1 inline-block rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[8px] uppercase text-primary">test account · {profile.testRole?.replaceAll("_", " ")}</span>}</span><ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /></button>
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
        {profile.isTestAccount && <div className="border-b border-primary/30 bg-primary/10 px-4 py-3 font-mono text-xs sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-bold text-primary">test mode</span>
            <span className="text-muted-foreground">You are viewing Relay as a test account.</span>
            <button type="button" onClick={() => void returnToOwner()} disabled={returningToOwner} className="rounded border border-primary/50 px-2.5 py-1.5 text-[10px] font-bold text-primary hover:bg-primary/10 disabled:opacity-50">{returningToOwner ? "returning…" : "Return to owner"}</button>
          </div>
          {returnOwnerError && <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-destructive"><span>{returnOwnerError}</span><button type="button" onClick={() => void signOut({ redirectUrl: `${basePath}/sign-in` })} className="rounded border border-destructive/40 px-2 py-1 font-bold hover:bg-destructive/10">sign out and sign in</button></div>}
        </div>}
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-3 py-5 sm:px-6">
              {!activeDm && !currentChannel ? <div className="flex h-full min-h-[300px] flex-col items-center justify-center px-6 text-center"><Hash className="mb-3 h-8 w-8 text-primary" /><p className="font-mono text-sm">{channels.length === 0 ? "no channels available" : "select a channel"}</p><p className="mt-2 max-w-xs font-mono text-[11px] text-muted-foreground">{channels.length === 0 ? "You do not have access to any channels yet." : "Choose an available room from the channel list."}</p><button onClick={() => void refreshChannels().catch(() => setChannelRefreshError("Could not refresh the channel list."))} className="mt-4 rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"><RefreshCw className="mr-2 inline h-3.5 w-3.5" />refresh channels</button>{channelRefreshError && <p className="mt-3 font-mono text-[10px] text-destructive">{channelRefreshError}</p>}</div> : room.loading ? <p className="font-mono text-xs text-muted-foreground">loading history…</p> : room.messages.length === 0 ? <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center"><MessageSquare className="mb-3 h-8 w-8 text-primary" /><p className="font-mono text-sm">the room is quiet</p><p className="mt-2 max-w-xs font-mono text-[11px] text-muted-foreground">Start the conversation and make the room yours.</p></div> : <div className="space-y-5">{activeDm && room.hasOlder && <div className="text-center"><button type="button" onClick={() => void room.loadOlderMessages()} disabled={room.loadingOlder} className="rounded border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50">{room.loadingOlder ? "loading older messages…" : "load older messages"}</button>{room.olderMessagesError && <p className="mt-2 font-mono text-[10px] text-destructive">{room.olderMessagesError}</p>}</div>}{room.messages.map((message) => <MessageRow key={message.id} message={message} currentUserId={profile.id} onDelete={deleteMessage} onToggleReaction={toggleReaction} />)}</div>}
              {room.messages.length > 0 && <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3"><span className="font-mono text-[9px] uppercase tracking-[.12em] text-muted-foreground">reply to</span>{room.messages.slice(-4).map((message) => <button key={message.id} type="button" onClick={() => setReplyingTo(message)} disabled={message.kind === "deleted"} className="max-w-full truncate rounded border border-border px-2 py-1 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40">{message.sender?.displayName ?? "unknown sender"}: {message.body}</button>)}</div>}
              {Object.keys(typingUsers).length > 0 && <p className="mt-3 font-mono text-[10px] text-muted-foreground">{room.members.filter((member) => typingUsers[member.id]).map((member) => member.displayName).join(", ") || "Someone"} typing…</p>}
            </div>
             <div className="border-t border-border bg-card/70 px-3 pb-4 pt-3 sm:px-6"><form onSubmit={sendMessage} className="flex items-end gap-2 rounded-lg border border-input bg-background p-2 focus-within:border-primary"><input ref={fileInputRef} type="file" accept="image/*,text/*,application/pdf" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void sendAttachment(file); }} /><button type="button" onClick={() => fileInputRef.current?.click()} disabled={!currentChannelId || Boolean(activeDm) || uploading} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40" aria-label="Share a file"><Paperclip className="h-4 w-4" /></button><textarea disabled={!activeDm && !currentChannelId} value={draft} onChange={(event) => sendTyping(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={1} maxLength={500} placeholder={activeDm ? `message @${activeDm.username}` : currentChannel?.name ? `message ${currentChannel.name}` : "Select a channel to message"} className="max-h-28 min-h-[28px] flex-1 resize-none bg-transparent px-2 py-1 font-mono text-xs outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed" /><button type="submit" disabled={!draft.trim() || uploading || (!activeDm && !currentChannelId)} className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"><MessageCircle className="h-4 w-4" /></button></form><div className="mt-2 flex justify-between px-1 font-mono text-[9px] text-muted-foreground"><span><b>enter</b> send · <b>shift + enter</b> new line · <b>paperclip</b> share</span><span className={connection === "live" ? "text-chart-4" : "text-primary"}>● {uploading ? "uploading" : connection}</span></div></div>
             {replyingTo && <div className="border-t border-border bg-primary/5 px-3 py-2 sm:px-6"><div className="flex items-center justify-between gap-3"><p className="min-w-0 truncate font-mono text-[10px] text-primary">Replying to {replyingTo.sender?.displayName ?? "unknown sender"}: {replyingTo.body}</p><button type="button" onClick={() => setReplyingTo(null)} className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-foreground">cancel</button></div></div>}
           </section>
          {showMembers && !activeDm && <aside className="hidden w-[285px] shrink-0 border-l border-border bg-card/70 lg:flex lg:flex-col"><div className="border-b border-border px-4 py-5"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">in the room</p><p className="mt-1 font-mono text-lg font-bold">{room.members.length} <span className="text-xs font-normal text-muted-foreground">people</span></p></div><div className="flex-1 overflow-y-auto p-3">{room.members.map((member) => <div key={member.id} className="group rounded-md px-2 py-2 hover:bg-muted"><div className="flex items-center gap-2"><Avatar user={member} size="sm" /><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs">{member.displayName} {member.status === "online" ? <span className="ml-1 text-chart-4">●</span> : <span className="ml-1 text-muted-foreground">○</span>}</p><p className="font-mono text-[9px] text-muted-foreground">@{member.username} · {member.role}</p></div><button onClick={() => setActiveDm(member)} className="rounded p-1 text-muted-foreground hover:text-primary" aria-label={`Message ${member.displayName}`}><MessageCircle className="h-3.5 w-3.5" /></button></div>{member.id !== profile.id && <div className="mt-2 hidden gap-1 group-hover:flex"><button onClick={() => blockUser(member)} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-accent hover:text-accent">block</button>{actorRole === "owner" && member.role === "member" && <button onClick={() => moderate(member, "moderator")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-secondary-foreground hover:text-secondary-foreground">mod</button>}{["owner", "moderator"].includes(actorRole ?? "") && member.role === "member" && <><button onClick={() => moderate(member, "mute")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary">mute</button><button onClick={() => moderate(member, "kick")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary">kick</button><button onClick={() => moderate(member, "ban")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-destructive hover:text-destructive">ban</button></>}</div>}</div>)}</div></aside>}
        </div>
      </main>

      {panel === "notifications" && <Overlay title="Business notifications" onClose={() => setPanel(null)}><div className="mb-4 flex gap-1 overflow-x-auto pb-1">{(["all", "direct_message", "mention", "task_assigned", "task_updated", "task_deadline", "announcement", "document_acknowledgement", "join_request", "report", "administrative_action"] as const).map((category) => <button key={category} onClick={() => setNotificationFilter(category)} className={`shrink-0 rounded border px-2 py-1 font-mono text-[9px] ${notificationFilter === category ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>{category === "all" ? "All" : notificationCategoryLabels[category]}</button>)}</div><div className="space-y-2">{visibleNotifications.length === 0 ? <p className="font-mono text-xs text-muted-foreground">You are all caught up.</p> : visibleNotifications.map((notice) => <button key={notice.id} onClick={() => void markRead(notice)} className={`flex w-full items-start gap-3 rounded-lg p-3 text-left ${notice.readAt ? "bg-muted/30" : "bg-primary/10"}`}><Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span className="min-w-0"><span className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-primary">{notificationCategoryLabels[notice.category]}</span><span className="block font-mono text-xs">{notice.body}</span><span className="mt-1 block font-mono text-[10px] text-muted-foreground">{timeLabel(notice.createdAt)} {notice.readAt ? "· read" : "· new"}{notice.actionUrl ? " · open" : ""}</span></span></button>)}</div></Overlay>}
      {panel === "profile" && <Overlay title="Your profile" onClose={() => setPanel(null)}><form onSubmit={saveProfile} className="space-y-4"><div className="flex items-center gap-3"><Avatar user={profile} size="lg" /><div><p className="font-mono text-sm font-bold">{profile.displayName}</p><p className="font-mono text-xs text-muted-foreground">Account profile · {profile.role === "admin" ? "platform admin / developer" : profile.role?.replaceAll("_", " ") || "member"}</p></div></div><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">username</span><input name="username" defaultValue={profile.username} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">display name</span><input name="displayName" defaultValue={profile.displayName} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><button className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground"><Check className="h-4 w-4" /> save profile</button><a href={`${basePath}/communities`} className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 font-mono text-xs text-muted-foreground hover:bg-muted"><Users className="h-4 w-4" /> open communities</a>{profile.role === "admin" && <a href={`${basePath}/developer`} className="flex w-full items-center justify-center gap-2 rounded-md border border-primary/40 py-2.5 font-mono text-xs text-primary hover:bg-primary/10"><Zap className="h-4 w-4" /> open developer studio</a>}<a href={`${basePath}/admin`} className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 font-mono text-xs text-muted-foreground hover:bg-muted"><Shield className="h-4 w-4" /> open platform console</a><button type="button" onClick={() => signOut({ redirectUrl: basePath || "/" })} className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 font-mono text-xs text-muted-foreground hover:bg-muted"><LogOut className="h-4 w-4" /> sign out</button></form></Overlay>}
       {showRequests && <Overlay title={`Join requests · ${currentChannel?.name ?? ""}`} onClose={() => setShowRequests(false)}><div className="space-y-2">{joinRequests.length === 0 ? <p className="font-mono text-xs text-muted-foreground">No pending requests.</p> : joinRequests.map((request) => <div key={request.id} className="flex items-center gap-3 rounded-lg border border-border p-3"><Avatar user={request.user} size="sm" /><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs font-bold">{request.user.displayName}</p><p className="font-mono text-[10px] text-muted-foreground">@{request.user.username}</p></div><button onClick={() => void decideJoinRequest(request, "reject")} className="rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground hover:text-destructive">decline</button><button onClick={() => void decideJoinRequest(request, "approve")} className="rounded bg-primary px-2 py-1 font-mono text-[10px] font-bold text-primary-foreground">approve</button></div>)}</div></Overlay>}
      {panel === "search" && <Overlay title={`Search results for “${search}”`} onClose={() => setPanel(null)}><div className="space-y-4">{searchResults.length === 0 ? <p className="font-mono text-xs text-muted-foreground">No messages found.</p> : searchResults.map((message) => <div key={message.id} className="border-b border-border pb-3"><div className="flex justify-between font-mono text-[10px] text-muted-foreground"><span className="text-secondary-foreground">{message.sender?.displayName}</span><span>{timeLabel(message.createdAt)}</span></div><p className="mt-1 text-sm">{message.body}</p></div>)}</div></Overlay>}
       {newChannelOpen && <Overlay title="Create a room" onClose={() => { if (!creatingChannel) { setNewChannelOpen(false); setCreateChannelError(""); } }}><form onSubmit={createChannel} className="space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">channel name</span><input autoFocus required value={newChannelName} onChange={(event) => setNewChannelName(event.target.value)} placeholder="#room-name" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">topic</span><input value={newChannelTopic} onChange={(event) => setNewChannelTopic(event.target.value)} placeholder="What is this room about?" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">description</span><input value={newChannelDescription} onChange={(event) => setNewChannelDescription(event.target.value)} placeholder="A short description for members" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label>{categories.length > 0 && <label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">category</span><select value={newChannelCategoryId} onChange={(event) => setNewChannelCategoryId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary"><option value="">no category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}<label className="flex items-center gap-2 font-mono text-xs"><input type="checkbox" checked={newChannelPrivate} onChange={(event) => setNewChannelPrivate(event.target.checked)} /> private room (owner approval)</label><label className="flex items-center gap-2 font-mono text-xs"><input type="checkbox" checked={newChannelInviteOnly} onChange={(event) => setNewChannelInviteOnly(event.target.checked)} /> invite-only</label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">optional password</span><input type="password" minLength={4} value={newChannelPassword} onChange={(event) => setNewChannelPassword(event.target.value)} placeholder="at least 4 characters" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label>{createChannelError && <p className="rounded border border-destructive/30 bg-destructive/10 p-2 font-mono text-[10px] text-destructive">{createChannelError}</p>}<button disabled={creatingChannel} className="w-full rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground disabled:opacity-50">{creatingChannel ? "creating room…" : "create room"}</button></form></Overlay>}
       {newCategoryOpen && <Overlay title="Create a category" onClose={() => setNewCategoryOpen(false)}><form onSubmit={createCategory} className="space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">category name</span><input autoFocus required value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="design team" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">description</span><input value={newCategoryDescription} onChange={(event) => setNewCategoryDescription(event.target.value)} placeholder="What belongs here?" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><button className="w-full rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground">create category</button></form></Overlay>}
    </div>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-40 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center"><div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="font-mono text-base font-bold">{title}</h2><button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close"><X className="h-4 w-4" /></button></div>{children}</div></div>;
}

function OwnerConfirmOverlay({ title, description, phrase, confirmLabel, working, error, onConfirm, onClose }: {
  title: string;
  description: string;
  phrase: string;
  confirmLabel: string;
  working: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const matches = value.trim() === phrase;
  return <Overlay title={title} onClose={() => { if (!working) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (matches && !working) onConfirm(); }} className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      <p className="rounded border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive">This action cannot be undone.</p>
      <label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">Type <strong className="text-foreground">{phrase}</strong> to confirm</span><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" aria-label={`Type ${phrase} to confirm`} /></label>
      {error && <p role="alert" className="rounded border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={working} onClick={onClose} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground">cancel</button><button type="submit" disabled={!matches || working} className="rounded-md bg-destructive px-3 py-2 font-mono text-[10px] font-bold text-destructive-foreground disabled:opacity-50">{working ? "working…" : confirmLabel}</button></div>
    </form>
  </Overlay>;
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
  users: Array<{ id: string; username: string; displayName: string; role: string; status: string; accountStatus: "active" | "suspended"; createdAt: string; lastSeenAt: string }>;
  channels: Array<{ id: number; name: string; topic: string; memberCount: number; createdAt: string }>;
  recentMessages: Array<{ id: string; body: string; sender: string; channelId: number | null; createdAt: string }>;
  activity: Array<{ id: string; action: string; targetId?: string | null; targetLabel?: string | null; details?: string | null; createdAt: string; actor?: string | { username?: string; displayName?: string } | null }>;
  activityPagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
};
type AdminAssignment = {
  id: number;
  userId: string;
  username: string;
  displayName: string;
  role: string;
  scopeType: string;
  communityId: number | null;
  communityName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  channelId: number | null;
  channelName: string | null;
  createdAt: string;
};
type AdminScopeOptions = {
  communities: Array<{ id: number; name: string }>;
  categories: Array<{ id: number; name: string; communityId: number | null }>;
  channels: Array<{ id: number; name: string; communityId: number | null; categoryId: number | null }>;
};
type CustomRole = {
  key: string;
  label: string;
  description: string;
  scopeType: "community" | "category" | "channel";
  permissions: string[];
};
type CustomRoleCatalog = {
  roles: CustomRole[];
  permissions: Array<{ key: string }>;
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

function AdminAccountsPanel({
  accounts,
  query,
  setQuery,
  roleFilter,
  setRoleFilter,
  statusFilter,
  setStatusFilter,
  accountStatusFilter,
  setAccountStatusFilter,
  currentId,
  working,
  onRole,
  onAccountStatus,
}: {
  accounts: ConsoleOverview["users"];
  query: string;
  setQuery: (value: string) => void;
  roleFilter: string;
  setRoleFilter: (value: string) => void;
  statusFilter: string;
  setStatusFilter: (value: string) => void;
  accountStatusFilter: string;
  setAccountStatusFilter: (value: string) => void;
  currentId: string;
  working: boolean;
  onRole: (account: ConsoleOverview["users"][number], role: "admin" | "moderator" | "community_admin" | "member") => void;
  onAccountStatus: (account: ConsoleOverview["users"][number], accountStatus: "active" | "suspended") => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-mono text-sm font-bold">account directory</h2>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">{accounts.length} matching accounts</p>
          </div>
          <Users className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search username or display name" className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 font-mono text-[11px] outline-none focus:border-primary" data-testid="input-account-search" />
          </div>
          <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 font-mono text-[10px] outline-none focus:border-primary" data-testid="select-account-role">
            <option value="all">all roles</option>
            <option value="admin">admins / developers</option>
            <option value="moderator">moderators</option>
            <option value="community_admin">community admins</option>
            <option value="member">members</option>
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 font-mono text-[10px] outline-none focus:border-primary" data-testid="select-account-presence">
            <option value="all">all presence</option>
            <option value="online">online</option>
            <option value="offline">offline</option>
          </select>
          <select value={accountStatusFilter} onChange={(event) => setAccountStatusFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 font-mono text-[10px] outline-none focus:border-primary" data-testid="select-account-status">
            <option value="all">all access</option>
            <option value="active">active</option>
            <option value="suspended">suspended</option>
          </select>
        </div>
      </div>
      <div className="divide-y divide-border">
        {accounts.map((account) => (
          <div key={account.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${account.accountStatus === "suspended" ? "bg-destructive" : account.status === "online" ? "bg-chart-4" : "bg-muted-foreground/35"}`} />
            <div className="min-w-[160px] flex-1">
              <p className="truncate font-mono text-xs font-bold">{account.displayName}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">@{account.username} · joined {timeLabel(account.createdAt)}</p>
            </div>
            <span className={`rounded px-2 py-1 font-mono text-[9px] uppercase ${account.role === "admin" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>{account.role === "admin" ? "admin / developer" : account.role}</span>
            <span className={`rounded px-2 py-1 font-mono text-[9px] uppercase ${account.accountStatus === "suspended" ? "bg-destructive/10 text-destructive" : "bg-chart-4/10 text-chart-4"}`}>{account.accountStatus}</span>
            {account.id === currentId ? (
              <span className="font-mono text-[9px] text-muted-foreground">you</span>
            ) : (
              <>
                <select disabled={working} value={account.role} onChange={(event) => onRole(account, event.target.value as "admin" | "moderator" | "community_admin" | "member")} className="rounded border border-border bg-background px-2 py-1.5 font-mono text-[9px] text-muted-foreground outline-none hover:border-primary hover:text-primary disabled:opacity-40" data-testid={`select-role-${account.id}`}>
                  <option value="admin">admin / developer</option>
                  <option value="moderator">moderator</option>
                  <option value="community_admin">community admin</option>
                  <option value="member">member</option>
                </select>
                <button disabled={working} onClick={() => onAccountStatus(account, account.accountStatus === "suspended" ? "active" : "suspended")} className={`rounded border px-2 py-1.5 font-mono text-[9px] disabled:opacity-40 ${account.accountStatus === "suspended" ? "border-chart-4/30 text-chart-4 hover:bg-chart-4/10" : "border-destructive/30 text-destructive hover:bg-destructive/10"}`} data-testid={`button-account-status-${account.id}`}>
                  {account.accountStatus === "suspended" ? "restore" : "suspend"}
                </button>
              </>
            )}
          </div>
        ))}
        {accounts.length === 0 && <EmptyAdminState label="No accounts match these filters." />}
      </div>
    </section>
  );
}

function AdminChannelsPanel({ channels, editingChannel, topicDraft, setTopicDraft, working, onEdit, onSave, onCancel, onClear }: { channels: ConsoleOverview["channels"]; editingChannel: number | null; topicDraft: string; setTopicDraft: (value: string) => void; working: boolean; onEdit: (channel: ConsoleOverview["channels"][number]) => void; onSave: (id: number) => void; onCancel: () => void; onClear: (channel: ConsoleOverview["channels"][number]) => void }) {
  return <section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><div className="flex items-center justify-between"><div><h2 className="font-mono text-sm font-bold">channel registry</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{channels.length} public rooms</p></div><Hash className="h-4 w-4 text-primary" /></div></div><div className="divide-y divide-border">{channels.map((channel) => <div key={channel.id} className="px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="font-mono text-sm font-bold text-secondary-foreground">{channel.name}</span><span className="font-mono text-[9px] text-muted-foreground">{channel.memberCount} members</span></div>{editingChannel === channel.id ? <div className="mt-3 flex flex-col gap-2 sm:flex-row"><input autoFocus value={topicDraft} onChange={(event) => setTopicDraft(event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-[11px] outline-none focus:border-primary" data-testid={`input-topic-${channel.id}`} /><button disabled={working} onClick={() => onSave(channel.id)} className="flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50"><Save className="h-3.5 w-3.5" />save</button><button onClick={onCancel} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground">cancel</button></div> : <p className="mt-2 truncate text-xs text-muted-foreground">{channel.topic || "No topic set"}</p>}</div>{editingChannel !== channel.id && <div className="flex gap-2"><button onClick={() => onEdit(channel)} className="rounded-md border border-border px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary"><Settings className="mr-1 inline h-3 w-3" />edit topic</button><button onClick={() => onClear(channel)} className="rounded-md border border-destructive/30 px-2.5 py-1.5 font-mono text-[9px] text-destructive hover:bg-destructive/10"><Trash2 className="mr-1 inline h-3 w-3" />clear history</button></div>}</div><p className="mt-3 font-mono text-[9px] text-muted-foreground/70">created {timeLabel(channel.createdAt)}</p></div>)}{channels.length === 0 && <EmptyAdminState label="No public channels have been created." />}</div></section>;
}

function AdminRoleAssignmentsPanel({
  assignments,
  users,
  options,
  working,
  onGrant,
  onRevoke,
  customRoles,
  permissions,
  onCreateCustomRole,
}: {
  assignments: AdminAssignment[];
  users: ConsoleOverview["users"];
  options: AdminScopeOptions;
  working: boolean;
  onGrant: (value: { userId: string; role: string; scopeType: string; communityId: number | null; categoryId: number | null; channelId: number | null }) => void;
  onRevoke: (assignment: AdminAssignment) => void;
  customRoles: CustomRole[];
  permissions: Array<{ key: string }>;
  onCreateCustomRole: (value: { label: string; description: string; scopeType: string; permissions: string[] }) => void;
}) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("platform_moderator");
  const [scopeType, setScopeType] = useState("platform");
  const [scopeId, setScopeId] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customScope, setCustomScope] = useState("community");
  const [customPermissions, setCustomPermissions] = useState<string[]>([]);
  useEffect(() => {
    if (!userId && users[0]) setUserId(users[0].id);
  }, [userId, users]);
  useEffect(() => {
    setScopeId("");
  }, [scopeType]);
  const scopeOptions = scopeType === "community"
    ? options.communities
    : scopeType === "category"
      ? options.categories
      : scopeType === "channel"
        ? options.channels
        : [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const selectedId = scopeType === "platform" ? null : Number(scopeId);
    if (scopeType !== "platform" && !Number.isInteger(selectedId)) return;
    onGrant({
      userId,
      role,
      scopeType,
      communityId: scopeType === "community" ? selectedId : null,
      categoryId: scopeType === "category" ? selectedId : null,
      channelId: scopeType === "channel" ? selectedId : null,
    });
  };
  const scopeLabel = (assignment: AdminAssignment) => assignment.scopeType === "platform"
    ? "platform"
    : assignment.scopeType === "community"
      ? `community · ${assignment.communityName ?? assignment.communityId}`
      : assignment.scopeType === "category"
        ? `category · ${assignment.categoryName ?? assignment.categoryId}`
        : `channel · ${assignment.channelName ?? assignment.channelId}`;
  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-mono text-sm font-bold">grant scoped role</h2>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">Give a user the minimum role needed for a platform or business scope.</p>
        </div>
        <form onSubmit={submit} className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <label className="font-mono text-[10px] text-muted-foreground">user
            <select required value={userId} onChange={(event) => setUserId(event.target.value)} className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-[11px] text-foreground outline-none focus:border-primary">
              <option value="" disabled>select a user</option>
              {users.map((user) => <option key={user.id} value={user.id}>{user.displayName} (@{user.username})</option>)}
            </select>
          </label>
          <label className="font-mono text-[10px] text-muted-foreground">role
            <select value={role} onChange={(event) => { const nextRole = event.target.value; setRole(nextRole); if (nextRole === "business_owner") setScopeType("community"); }} className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-[11px] text-foreground outline-none focus:border-primary">
              <option value="platform_moderator">platform moderator</option>
              <option value="workspace_owner">workspace owner</option>
              <option value="workspace_admin">workspace admin</option>
              <option value="department_admin">community / department admin</option>
              <option value="manager">manager</option>
              <option value="moderator">moderator</option>
              {customRoles.map((customRole) => <option key={customRole.key} value={customRole.key}>{customRole.label} (custom)</option>)}
            </select>
          </label>
          <label className="font-mono text-[10px] text-muted-foreground">scope
            <select value={scopeType} onChange={(event) => setScopeType(event.target.value)} className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-[11px] text-foreground outline-none focus:border-primary">
              <option value="platform">platform</option>
              <option value="community">workspace</option>
              <option value="category">community / department</option>
              <option value="channel">channel</option>
            </select>
          </label>
          <label className="font-mono text-[10px] text-muted-foreground">{scopeType === "platform" ? "scope selection" : "scope target"}
            <select disabled={scopeType === "platform"} required={scopeType !== "platform"} value={scopeId} onChange={(event) => setScopeId(event.target.value)} className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-[11px] text-foreground outline-none focus:border-primary disabled:opacity-50">
              <option value="">{scopeType === "platform" ? "not applicable" : "select a scope"}</option>
              {scopeOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <button disabled={working || !userId || (scopeType !== "platform" && !scopeId)} className="rounded-md bg-primary px-4 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">grant role</button>
          </div>
        </form>
      </section>
      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-mono text-sm font-bold">create custom role</h2>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">Build a reusable role from the permissions your organization needs.</p>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); onCreateCustomRole({ label: customLabel, description: customDescription, scopeType: customScope, permissions: customPermissions }); setCustomLabel(""); setCustomDescription(""); setCustomPermissions([]); }} className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <input required value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder="Store Manager" className="h-9 rounded-md border border-input bg-background px-3 font-mono text-[11px]" />
            <input value={customDescription} onChange={(event) => setCustomDescription(event.target.value)} placeholder="Manages store operations" className="h-9 rounded-md border border-input bg-background px-3 font-mono text-[11px]" />
            <select value={customScope} onChange={(event) => setCustomScope(event.target.value)} className="h-9 rounded-md border border-input bg-background px-2 font-mono text-[11px]">
              <option value="community">workspace role</option>
              <option value="category">department role</option>
              <option value="channel">channel role</option>
            </select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {permissions.map((permission) => <label key={permission.key} className="flex items-center gap-2 rounded border border-border/70 px-2.5 py-2 font-mono text-[10px] text-muted-foreground">
              <input type="checkbox" checked={customPermissions.includes(permission.key)} onChange={(event) => setCustomPermissions((current) => event.target.checked ? [...current, permission.key] : current.filter((item) => item !== permission.key))} />
              {permission.key.replaceAll("_", " ")}
            </label>)}
          </div>
          <button disabled={working || !customLabel || customPermissions.length === 0} className="rounded-md bg-primary px-4 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">save custom role</button>
        </form>
      </section>
      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-mono text-sm font-bold">active scoped assignments</h2>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{assignments.length} assignments</p>
        </div>
        <div className="divide-y divide-border">
          {assignments.map((assignment) => <div key={assignment.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <div className="min-w-[180px] flex-1"><p className="font-mono text-xs font-bold">{assignment.displayName}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">@{assignment.username}</p></div>
            <span className="rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary">{assignment.role}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{scopeLabel(assignment)}</span>
            <button disabled={working} onClick={() => onRevoke(assignment)} className="rounded border border-destructive/30 px-2.5 py-1.5 font-mono text-[9px] text-destructive hover:bg-destructive/10 disabled:opacity-40">revoke</button>
          </div>)}
          {assignments.length === 0 && <EmptyAdminState label="No scoped roles have been assigned." />}
        </div>
      </section>
      {customRoles.length > 0 && <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">custom role catalog</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{customRoles.length} reusable roles</p></div>
        <div className="divide-y divide-border">{customRoles.map((customRole) => <div key={customRole.key} className="px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold">{customRole.label}</p><p className="mt-1 text-xs text-muted-foreground">{customRole.description || "No description."}</p></div><span className="rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary">{customRole.scopeType}</span></div><div className="mt-3 flex flex-wrap gap-1.5">{customRole.permissions.map((permission) => <span key={permission} className="rounded bg-muted px-2 py-1 font-mono text-[9px] text-muted-foreground">{permission.replaceAll("_", " ")}</span>)}</div></div>)}</div>
      </section>}
    </div>
  );
}

function AdminConfirmDialog({ title, description, confirmLabel, destructive, working, onConfirm, onCancel }: { title: string; description: string; confirmLabel: string; destructive?: boolean; working: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/75 p-4 backdrop-blur-sm sm:items-center"><div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"><div className="flex gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${destructive ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"}`}>{destructive ? <AlertTriangle className="h-4 w-4" /> : <Shield className="h-4 w-4" />}</div><div><h2 className="font-mono text-sm font-bold">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p></div></div><div className="mt-6 flex justify-end gap-2"><button onClick={onCancel} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:bg-muted">cancel</button><button disabled={working} onClick={onConfirm} className={`rounded-md px-3 py-2 font-mono text-[10px] font-bold disabled:opacity-50 ${destructive ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`} data-testid="button-confirm-admin-action">{working ? "working…" : confirmLabel}</button></div></div></div>;
}

function AdminConsole() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [overview, setOverview] = useState<ConsoleOverview | null>(null);
  const [directory, setDirectory] = useState<ConsoleOverview["users"]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [roleAssignments, setRoleAssignments] = useState<AdminAssignment[]>([]);
  const [scopeOptions, setScopeOptions] = useState<AdminScopeOptions>({ communities: [], categories: [], channels: [] });
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [customRolePermissions, setCustomRolePermissions] = useState<Array<{ key: string }>>([]);
  const [health, setHealth] = useState<ConsoleHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlderActivity, setLoadingOlderActivity] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [section, setSection] = useState<"overview" | "accounts" | "channels" | "roles" | "activity" | "system">("overview");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [accountStatusFilter, setAccountStatusFilter] = useState("all");
  const [activityActorFilter, setActivityActorFilter] = useState("");
  const [activityActionFilter, setActivityActionFilter] = useState("");
  const [pendingRole, setPendingRole] = useState<{ id: string; label: string; role: "admin" | "moderator" | "community_admin" | "member" } | null>(null);
  const [pendingAccountStatus, setPendingAccountStatus] = useState<{ id: string; label: string; accountStatus: "active" | "suspended" } | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<AdminAssignment | null>(null);
  const [editingChannel, setEditingChannel] = useState<number | null>(null);
  const [topicDraft, setTopicDraft] = useState("");
  const [pendingClear, setPendingClear] = useState<{ id: number; name: string } | null>(null);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [announcementDraft, setAnnouncementDraft] = useState("");
  const load = async (activityOffset = 0, appendActivity = false) => {
    setError("");
    try {
      const activityParams = new URLSearchParams();
      if (activityOffset > 0) activityParams.set("activityOffset", String(activityOffset));
      if (activityActorFilter.trim()) activityParams.set("activityActor", activityActorFilter.trim());
      if (activityActionFilter.trim()) activityParams.set("activityAction", activityActionFilter.trim());
      const overviewPath = activityParams.toString() ? `/admin/overview?${activityParams.toString()}` : "/admin/overview";
      const [nextOverview, nextHealth] = await Promise.all([api<ConsoleOverview>(overviewPath), api<ConsoleHealth>("/admin/health")]);
      if (!appendActivity) {
        setOverview(nextOverview);
      } else {
        setOverview((current) => {
          if (!current) return nextOverview;
          const existingIds = new Set(current.activity.map((item) => item.id));
          const activity = [...current.activity, ...nextOverview.activity.filter((item) => !existingIds.has(item.id))];
          return { ...nextOverview, activity };
        });
      }
      setHealth(nextHealth);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the operations console");
    }
  };
  const loadRoleData = async () => {
    try {
      const [assignments, options, catalog] = await Promise.all([
        api<AdminAssignment[]>("/admin/role-assignments"),
        api<AdminScopeOptions>("/admin/scope-options"),
        api<CustomRoleCatalog>("/admin/custom-roles"),
      ]);
      setRoleAssignments(assignments);
      setScopeOptions(options);
      setCustomRoles(catalog.roles);
      setCustomRolePermissions(catalog.permissions);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load scoped roles");
    }
  };
  useEffect(() => { api<AdminStatus>("/admin/status").then(setStatus).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load admin status")).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (status?.isAdmin) void load(); }, [status?.isAdmin]);
  useEffect(() => { if (status?.isAdmin && section === "roles") void loadRoleData(); }, [status?.isAdmin, section]);
  useEffect(() => {
    if (!status?.isAdmin || (section !== "accounts" && section !== "roles")) return;
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (accountStatusFilter !== "all") params.set("accountStatus", accountStatusFilter);
    api<ConsoleOverview["users"] | { users: ConsoleOverview["users"] }>(`/admin/users${params.toString() ? `?${params.toString()}` : ""}`)
      .then((result) => { setDirectory(Array.isArray(result) ? result : result.users); setDirectoryLoaded(true); })
      .catch(() => { setDirectory([]); setDirectoryLoaded(true); });
  }, [status?.isAdmin, section, query, roleFilter, statusFilter, accountStatusFilter]);
  useEffect(() => {
    if (!status?.isAdmin || section !== "activity") return;
    void load();
  }, [status?.isAdmin, section, activityActorFilter, activityActionFilter]);
  const claim = async () => { setWorking(true); try { await api("/admin/claim", { method: "POST", body: "{}" }); setStatus((value) => value ? { ...value, isAdmin: true, bootstrapAvailable: false } : value); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not claim admin access"); } finally { setWorking(false); } };
  const updateRole = async () => { if (!pendingRole) return; setWorking(true); try { await api(`/admin/users/${pendingRole.id}/role`, { method: "PATCH", body: JSON.stringify({ role: pendingRole.role }) }); setNotice(`Role updated for ${pendingRole.label}.`); setPendingRole(null); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update role"); } finally { setWorking(false); } };
  const updateAccountStatus = async () => { if (!pendingAccountStatus) return; setWorking(true); try { await api(`/admin/users/${pendingAccountStatus.id}/account-status`, { method: "PATCH", body: JSON.stringify({ accountStatus: pendingAccountStatus.accountStatus }) }); setNotice(`${pendingAccountStatus.label} is now ${pendingAccountStatus.accountStatus}.`); setPendingAccountStatus(null); setDirectoryLoaded(false); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update account status"); } finally { setWorking(false); } };
  const grantRole = async (value: { userId: string; role: string; scopeType: string; communityId: number | null; categoryId: number | null; channelId: number | null }) => { setWorking(true); try { await api("/admin/role-assignments", { method: "POST", body: JSON.stringify(value) }); setNotice("Scoped role granted."); await loadRoleData(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not grant scoped role"); } finally { setWorking(false); } };
  const createCustomRole = async (value: { label: string; description: string; scopeType: string; permissions: string[] }) => { setWorking(true); try { await api("/admin/custom-roles", { method: "POST", body: JSON.stringify(value) }); setNotice(`${value.label} custom role created.`); await loadRoleData(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create custom role"); } finally { setWorking(false); } };
  const revokeRole = async () => { if (!pendingRevoke) return; setWorking(true); try { await api(`/admin/role-assignments/${pendingRevoke.id}`, { method: "DELETE" }); setNotice(`Revoked ${pendingRevoke.role} from ${pendingRevoke.displayName}.`); setPendingRevoke(null); await loadRoleData(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not revoke scoped role"); } finally { setWorking(false); } };
  const sendAnnouncement = async (event: FormEvent) => { event.preventDefault(); const body = announcementDraft.trim(); if (!body) return; setWorking(true); try { await api("/admin/announcements", { method: "POST", body: JSON.stringify({ body }) }); setAnnouncementDraft(""); setAnnouncementOpen(false); setNotice("Announcement sent to all users."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not send announcement"); } finally { setWorking(false); } };
  const saveTopic = async (id: number) => { setWorking(true); try { await api(`/admin/channels/${id}`, { method: "PATCH", body: JSON.stringify({ topic: topicDraft }) }); setEditingChannel(null); setNotice("Channel topic saved."); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save channel topic"); } finally { setWorking(false); } };
  const clearHistory = async () => { if (!pendingClear) return; setWorking(true); try { await api(`/admin/channels/${pendingClear.id}/messages`, { method: "DELETE", body: JSON.stringify({ confirm: true }) }); setNotice(`History cleared for ${pendingClear.name}.`); setPendingClear(null); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not clear channel history"); } finally { setWorking(false); } };
  const loadOlderActivity = async () => {
    const nextOffset = overview?.activityPagination.nextOffset;
    if (nextOffset === null || nextOffset === undefined || loadingOlderActivity) return;
    setLoadingOlderActivity(true);
    try {
      await load(nextOffset, true);
    } finally {
      setLoadingOlderActivity(false);
    }
  };
  const accounts = (directoryLoaded ? directory : overview?.users ?? []).filter((account) => { const q = query.trim().toLowerCase(); return (!q || account.username.toLowerCase().includes(q) || account.displayName.toLowerCase().includes(q)) && (roleFilter === "all" || account.role === roleFilter) && (statusFilter === "all" || account.status === statusFilter) && (accountStatusFilter === "all" || account.accountStatus === accountStatusFilter); });
  const nav: Array<[typeof section, string, LucideIcon]> = [["overview", "overview", LayoutDashboard], ["accounts", "accounts", Users], ["channels", "channels", Hash], ["roles", "scoped roles", Shield], ["activity", "activity", Activity], ["system", "system status", Server]];
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
          <div className="flex items-center gap-2"><div className="hidden items-center gap-2 border-r border-border pr-3 sm:flex"><span className="h-2 w-2 rounded-full bg-chart-4" /><span className="font-mono text-[10px] text-muted-foreground">authenticated</span></div><button onClick={() => setAnnouncementOpen(true)} className="hidden items-center gap-1.5 rounded-md border border-primary/40 px-3 py-2 font-mono text-[10px] text-primary hover:bg-primary/10 sm:flex"><Megaphone className="h-3.5 w-3.5" />announce</button><button disabled={working} onClick={() => void load()} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" aria-label="Refresh console" data-testid="button-refresh-admin"><RefreshCw className={`h-4 w-4 ${working ? "animate-spin" : ""}`} /></button><a href={`${basePath}/chat`} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground">back to chat</a></div>
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
           <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-primary">/{title}</p><h1 className="mt-2 font-mono text-2xl font-bold tracking-tight sm:text-3xl">{section === "overview" ? "Network at a glance." : section === "accounts" ? "Account governance." : section === "channels" ? "Public rooms." : section === "roles" ? "Scoped access." : section === "activity" ? "A clear audit trail." : "System status."}</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{section === "overview" ? "The essential signals for keeping Relay available, safe, and understandable." : section === "accounts" ? "Review identity, presence, and privilege without leaving the control room." : section === "channels" ? "Keep room context useful and remove history only when you mean to." : section === "roles" ? "Grant and revoke least-privilege access across platform and business scopes." : section === "activity" ? "Recent administrative changes and network events, newest first." : "A live read on the services behind the conversation."}</p></div><div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{health ? `checked ${timeLabel(health.checkedAt)}` : "checking signals"}</div></div>
          {error && <div className="mb-5 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span><button onClick={() => void load()} className="ml-auto underline">retry</button></div>}
          {notice && <div className="mb-5 flex items-center gap-2 rounded-md border border-chart-4/30 bg-chart-4/10 p-3 font-mono text-xs text-chart-4"><CheckCircle2 className="h-4 w-4" />{notice}<button onClick={() => setNotice("")} className="ml-auto" aria-label="Dismiss notice" title="Dismiss notice"><X className="h-3.5 w-3.5" /></button></div>}
          {!overview ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="h-28 animate-pulse rounded-lg border border-border bg-card" />)}</div> : section === "overview" ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{stats.map(([label, value, Icon]) => <div key={label} className="rounded-lg border border-border bg-card p-4"><div className="flex items-center justify-between"><Icon className="h-4 w-4 text-primary" /><span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">live</span></div><p className="mt-5 font-mono text-3xl font-bold">{value}</p><p className="mt-1 font-mono text-[10px] uppercase tracking-[.14em] text-muted-foreground">{label}</p></div>)}</div>
              <div className="grid gap-5 xl:grid-cols-[1.12fr_.88fr]"><section className="rounded-lg border border-border bg-card"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-mono text-sm font-bold">recent activity</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">The last operational changes</p></div><button onClick={() => setSection("activity")} className="font-mono text-[10px] text-primary hover:underline">view all</button></div><div className="divide-y divide-border">{overview.activity.slice(0, 6).map((item) => <AdminActivityRow key={item.id} item={item} actor={actor} />)}{overview.activity.length === 0 && <EmptyAdminState label="No activity recorded yet." />}</div></section><div className="space-y-5"><AdminHealthCard health={health} onOpen={() => setSection("system")} /><section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">recent messages</h2></div><div className="divide-y divide-border">{overview.recentMessages.slice(0, 5).map((message) => <div key={message.id} className="px-5 py-3"><div className="flex justify-between gap-3 font-mono text-[10px]"><span className="truncate text-secondary-foreground">{message.sender}</span><span className="shrink-0 text-muted-foreground">{timeLabel(message.createdAt)}</span></div><p className="mt-1 truncate text-xs">{message.body}</p></div>)}{overview.recentMessages.length === 0 && <EmptyAdminState label="No messages have been sent yet." />}</div></section></div></div>
            </div>
            ) : section === "accounts" ? <AdminAccountsPanel accounts={accounts} query={query} setQuery={setQuery} roleFilter={roleFilter} setRoleFilter={setRoleFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} accountStatusFilter={accountStatusFilter} setAccountStatusFilter={setAccountStatusFilter} currentId={status.profile.id} working={working} onRole={(account, role) => setPendingRole({ id: account.id, label: account.displayName, role })} onAccountStatus={(account, accountStatus) => setPendingAccountStatus({ id: account.id, label: account.displayName, accountStatus })} /> : section === "channels" ? <AdminChannelsPanel channels={overview.channels} editingChannel={editingChannel} topicDraft={topicDraft} setTopicDraft={setTopicDraft} working={working} onEdit={(channel) => { setEditingChannel(channel.id); setTopicDraft(channel.topic); }} onSave={saveTopic} onCancel={() => setEditingChannel(null)} onClear={(channel) => setPendingClear({ id: channel.id, name: channel.name })} /> : section === "roles" ? <AdminRoleAssignmentsPanel assignments={roleAssignments} users={directoryLoaded ? directory : overview.users} options={scopeOptions} working={working} onGrant={grantRole} onRevoke={setPendingRevoke} customRoles={customRoles} permissions={customRolePermissions} onCreateCustomRole={createCustomRole} /> : section === "activity" ? (
             <section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-mono text-sm font-bold">audit stream</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{overview.activity.length} recorded events</p></div><Activity className="h-4 w-4 text-primary" /></div><div className="mt-4 grid gap-2 sm:grid-cols-2"><input value={activityActorFilter} onChange={(event) => setActivityActorFilter(event.target.value)} placeholder="filter by actor" className="h-9 rounded-md border border-input bg-background px-3 font-mono text-[11px] outline-none focus:border-primary" data-testid="input-activity-actor" /><input value={activityActionFilter} onChange={(event) => setActivityActionFilter(event.target.value)} placeholder="filter by action" className="h-9 rounded-md border border-input bg-background px-3 font-mono text-[11px] outline-none focus:border-primary" data-testid="input-activity-action" /></div></div><div className="divide-y divide-border">{overview.activity.map((item) => <AdminActivityRow key={item.id} item={item} actor={actor} detailed />)}{overview.activity.length === 0 && <EmptyAdminState label="No administrative activity matches these filters." />}</div>{overview.activityPagination.hasMore && <div className="border-t border-border p-4 text-center"><button disabled={loadingOlderActivity} onClick={() => void loadOlderActivity()} className="rounded-md border border-border px-4 py-2 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50">{loadingOlderActivity ? "loading older activity…" : "load older activity"}</button></div>}</section>
          ) : (
            <div className="grid gap-5 xl:grid-cols-[1.25fr_.75fr]"><section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">service health</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Last probe: {health ? timeLabel(health.checkedAt) : "unavailable"}</p></div><div className="grid gap-px bg-border sm:grid-cols-2">{health ? <><HealthCell label="api" value={health.api} icon={Radio} /><HealthCell label="database" value={health.database} icon={Database} /><HealthCell label="database latency" value={`${health.databaseLatencyMs} ms`} icon={Clock3} /><HealthCell label="environment" value={health.environment} icon={Server} /><HealthCell label="uptime" value={`${Math.floor(health.uptimeSeconds / 3600)}h`} icon={Activity} /></> : <EmptyAdminState label="Health data is not available." />}</div></section><div className="rounded-lg border border-border bg-card p-5"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">administrator</p><div className="mt-5 flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-lg bg-secondary font-mono text-sm font-bold text-secondary-foreground">{initials(status.profile.displayName)}</div><div><p className="font-mono text-sm font-bold">{status.profile.displayName}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">@{status.profile.username}</p></div></div><div className="mt-6 border-t border-border pt-4 font-mono text-[10px] leading-5 text-muted-foreground">This account can change roles, update public room context, and permanently remove room history.</div></div></div>
          )}
        </main>
      </div>
      {announcementOpen && <Overlay title="Platform announcement" onClose={() => { if (!working) setAnnouncementOpen(false); }}><form onSubmit={sendAnnouncement}><p className="mb-4 text-sm leading-6 text-muted-foreground">This message will be delivered to every user as a notification.</p><textarea autoFocus required maxLength={500} value={announcementDraft} onChange={(event) => setAnnouncementDraft(event.target.value)} placeholder="Write a clear message for the network…" className="min-h-32 w-full resize-y rounded-md border border-input bg-background p-3 text-sm outline-none focus:border-primary" /><div className="mt-2 text-right font-mono text-[9px] text-muted-foreground">{announcementDraft.length}/500</div><div className="mt-5 flex justify-end gap-2"><button type="button" disabled={working} onClick={() => setAnnouncementOpen(false)} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground">cancel</button><button disabled={working || !announcementDraft.trim()} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50"><Megaphone className="h-3.5 w-3.5" />{working ? "sending…" : "send announcement"}</button></div></form></Overlay>}
      {pendingRole && <AdminConfirmDialog title={`Change role for ${pendingRole.label}?`} description={`${pendingRole.label} will become ${pendingRole.role === "admin" ? "an Admin / Developer" : pendingRole.role.replace("_", " ")}. Platform roles are enforced on the server.`} confirmLabel={`set ${pendingRole.role === "admin" ? "admin / developer" : pendingRole.role.replace("_", " ")}`} destructive={pendingRole.role === "member"} working={working} onConfirm={() => void updateRole()} onCancel={() => setPendingRole(null)} />}
      {pendingAccountStatus && <AdminConfirmDialog title={`${pendingAccountStatus.accountStatus === "suspended" ? "Suspend" : "Restore"} ${pendingAccountStatus.label}?`} description={pendingAccountStatus.accountStatus === "suspended" ? "This prevents the account from using the platform until an administrator restores it. Existing data is preserved." : "This restores the account's ability to sign in and use the platform."} confirmLabel={pendingAccountStatus.accountStatus === "suspended" ? "suspend account" : "restore account"} destructive={pendingAccountStatus.accountStatus === "suspended"} working={working} onConfirm={() => void updateAccountStatus()} onCancel={() => setPendingAccountStatus(null)} />}
      {pendingRevoke && <AdminConfirmDialog title={`Revoke ${pendingRevoke.role} from ${pendingRevoke.displayName}?`} description="This removes the selected scoped access. The user will keep any other platform or scoped roles." confirmLabel="revoke role" destructive working={working} onConfirm={() => void revokeRole()} onCancel={() => setPendingRevoke(null)} />}
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
  plan: "free_community" | "paid_workspace";
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
  isPrivate: boolean;
  joined: boolean;
  canManage: boolean;
};
type OnboardingCommunity = {
  id: number;
  name: string;
  slug: string;
  plan: "free_community" | "paid_workspace";
  onboardingStep: number;
  joined: boolean;
  canManage: boolean;
};
type OnboardingState = {
  nextStep: "create" | "configure" | "invite" | "start";
  ownerCommunity: OnboardingCommunity | null;
  communities: OnboardingCommunity[];
};
type CommunityDetail = {
  community: CommunitySummary;
  members: Array<{ id: string; username: string; displayName: string; status: string; joinedAt: string }>;
  categories: Array<{ id: number; name: string; description: string }>;
  channels: Array<{ id: number; name: string; topic: string; description: string; categoryId: number | null; isPrivate: boolean }>;
  assignments: Array<{ id: number; userId: string; role: string; scopeType: string; communityId: number | null }>;
  announcements: Array<{
    id: number;
    title: string;
    body: string;
    audienceType: string;
    departmentId: number | null;
    locationId: number | null;
    teamId: number | null;
    recipientId: string | null;
    requiresAcknowledgement: boolean;
    scheduledAt: string | null;
    expiresAt: string | null;
    status: string;
    author: string;
    createdAt: string;
    readAt: string | null;
    acknowledgedAt: string | null;
    readCount: number;
    acknowledgementCount: number;
    attachments: Array<{ id: number; announcementId: number; uploaderId: string; objectPath: string; fileName: string; contentType: string; fileSize: number; createdAt: string }>;
  }>;
  departments: Array<{ id: number; name: string; description: string; managerId: string | null; status: string }>;
  locations: Array<{ id: number; name: string; code: string; address: string; timezone: string; status: string }>;
  teams: Array<{ id: number; name: string; description: string; departmentId: number | null; locationId: number | null; managerId: string | null; status: string }>;
  employees: Array<{ userId: string; username: string; displayName: string; employeeNumber: string; jobTitle: string; employmentStatus: string; departmentId: number | null; locationId: number | null; managerId: string | null; teamIds: number[]; onboardedAt: string | null; offboardedAt: string | null; presenceStatus: string }>;
  teamMemberships: Array<{ teamId: number; userId: string; role: string; status: string; joinedAt: string; endedAt: string | null }>;
  invitations: Array<{ id: number; email: string; role: string; status: string; expiresAt: string; createdAt: string; acceptedAt?: string | null }>;
  policies: Array<{ id: number; title: string; body: string; version: number; status: string; effectiveAt: string; createdAt: string }>;
  tasks: Array<{
    id: number;
    title: string;
    description: string;
    assignedTo: string | null;
    departmentId: number | null;
    locationId: number | null;
    priority: string;
    dueDate: string | null;
    status: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    comments: Array<{ id: number; taskId: number; authorId: string; author: string; body: string; createdAt: string }>;
    attachments: Array<{ id: number; taskId: number; uploaderId: string; objectPath: string; fileName: string; contentType: string; fileSize: number; createdAt: string }>;
  }>;
  canManage: boolean;
  canManageOrganization: boolean;
  isOwner: boolean;
};
type OwnerConfirmation = {
  kind: "remove-member" | "delete-account" | "delete-channel" | "delete-workspace";
  id?: string | number;
  label: string;
  phrase: string;
};

export function ownerConfirmationPhrase(kind: OwnerConfirmation["kind"], target: string, workspace: string): string {
  if (kind === "remove-member") return `REMOVE MEMBER ${target} FROM WORKSPACE ${workspace}`;
  if (kind === "delete-account") return `DELETE ACCOUNT ${target} FROM WORKSPACE ${workspace}`;
  if (kind === "delete-channel") return `DELETE CHANNEL ${target} FROM WORKSPACE ${workspace}`;
  return `DELETE WORKSPACE ${workspace}`;
}

type TestAccount = { id: string; role: string; displayName: string; username?: string | null };

function TestAccountsPanel({ detail, setError, setNotice }: { detail: CommunityDetail; setError: (value: string) => void; setNotice: (value: string) => void }) {
  const { client, setActive } = useClerk();
  const { session } = useSession();
  const { user } = useUser();
  const [accounts, setAccounts] = useState<TestAccount[]>([]);
  const [working, setWorking] = useState(false);
  const roles = ["workspace_admin", "department_admin", "manager", "moderator", "member"];
  const load = useCallback(async () => {
    try {
      setAccounts(await api<TestAccount[]>(`/communities/${detail.community.id}/test-accounts`));
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) return;
      setError(reason instanceof Error ? reason.message : "Could not load test accounts");
    }
  }, [detail.community.id, setError]);
  useEffect(() => { void load(); }, [load]);
  if (!detail.isOwner) return null;
  const provision = async () => {
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/test-accounts/provision`, { method: "POST", body: "{}" });
      await load();
      setNotice("Relay test accounts are ready.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not provision test accounts");
    } finally { setWorking(false); }
  };
  const login = async (role: string) => {
    setWorking(true);
    try {
      if (!session?.id || !session.user?.id || !user?.id || session.user.id !== user.id) {
        throw new Error("Your owner session is unavailable or changed. Refresh and sign in again before switching accounts.");
      }
      const { ticket } = await api<{ ticket: string }>(`/communities/${detail.community.id}/test-accounts/${role}/login`, { method: "POST", body: "{}" });
      if (!client || !setActive) throw new Error("Clerk sign-in is unavailable.");
      const result = await client.signIn.create({ strategy: "ticket", ticket });
      if (result.status !== "complete" || !result.createdSessionId) {
        throw new Error(`Test account sign-in did not complete (${result.status}).`);
      }
      writeTestAccountReturnContext({
        ownerSessionId: session.id,
        ownerUserId: session.user.id,
        workspaceId: detail.community.id,
      });
      await setActive({ session: result.createdSessionId });
      window.location.assign(`${basePath}/chat`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in to test account");
      setWorking(false);
    }
  };
  return <section className="rounded-xl border border-primary/25 bg-card p-5" data-testid="panel-test-accounts">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">development only</p><h2 className="mt-2 font-mono text-sm font-bold">Test accounts</h2><p className="mt-1 text-xs text-muted-foreground">Owner-only accounts for checking each workspace role.</p></div><button data-testid="button-provision-test-accounts" disabled={working} onClick={() => void provision()} className="rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">{working ? "working…" : "provision all"}</button></div>
    <div className="mt-4 divide-y divide-border border-t border-border">{roles.map((role) => { const account = accounts.find((item) => item.role === role); return <div key={role} className="flex items-center gap-3 py-2.5"><span className="min-w-0 flex-1 font-mono text-xs">{role.replaceAll("_", " ")}</span>{account ? <><span className="truncate font-mono text-[10px] text-muted-foreground">{account.displayName}</span><button data-testid={`button-login-test-${role}`} disabled={working} onClick={() => void login(role)} className="rounded border border-border px-2 py-1 font-mono text-[9px] text-primary hover:bg-primary/10 disabled:opacity-50">log in</button></> : <span className="font-mono text-[10px] text-muted-foreground">not provisioned</span>}</div>; })}</div>
  </section>;
}

type BusinessDashboardPayload = {
  stats: { employees: number; online: number; channels: number; openTasks: number; announcements: number; pendingRequests: number };
  tasks: { open: number; dueThisWeek: number; overdue: number };
  recentActivity: Array<{ id: number; action: string; details: string | null; actor: string | null; createdAt: string }>;
};

type BusinessActivityEntry = {
  id: number;
  actorId: string;
  actor: string | null;
  action: string;
  departmentId: number | null;
  locationId: number | null;
  resourceType: string | null;
  resourceId: string | null;
  targetLabel: string | null;
  details: string | null;
  createdAt: string;
};
type BusinessActivityPayload = { entries: BusinessActivityEntry[]; actions: string[] };

function BusinessDashboard({ detail, setError }: { detail: CommunityDetail; setError: (value: string) => void }) {
  const [dashboard, setDashboard] = useState<BusinessDashboardPayload | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<BusinessDashboardPayload>(`/communities/${detail.community.id}/dashboard`).then((next) => {
      if (!cancelled) setDashboard(next);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load business dashboard");
    });
    return () => { cancelled = true; };
  }, [detail.community.id]);
  if (!dashboard) return <section className="h-52 animate-pulse rounded-xl border border-border bg-card" />;
  const statCards = [
    ["Employees", dashboard.stats.employees, `${dashboard.stats.online} online`],
    ["Online", dashboard.stats.online, "active now"],
    ["Channels", dashboard.stats.channels, "workspace rooms"],
    ["Open tasks", dashboard.stats.openTasks, "not completed"],
    ["Announcements", dashboard.stats.announcements, "currently active"],
    ["Pending requests", dashboard.stats.pendingRequests, "awaiting review"],
  ];
  return <section className="space-y-5">
    <div><p className="font-mono text-[10px] uppercase tracking-[.18em] text-primary">business overview</p><h2 className="mt-2 font-mono text-xl font-bold">Operational dashboard</h2><p className="mt-1 text-sm text-muted-foreground">A live view of the people, work, communication, and requests that need attention.</p></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{statCards.map(([label, value, caption]) => <div key={label} className="rounded-xl border border-border bg-card p-4"><div className="flex items-start justify-between gap-3"><p className="font-mono text-[10px] uppercase tracking-[.13em] text-muted-foreground">{label}</p><span className="h-2 w-2 rounded-full bg-chart-4" /></div><p className="mt-5 font-mono text-3xl font-bold">{value}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{caption}</p></div>)}</div>
    <div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]">
      <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">tasks</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">Workload and urgency</p></div><div className="grid grid-cols-3 divide-x divide-border"><div className="p-5"><p className="font-mono text-2xl font-bold">{dashboard.tasks.open}</p><p className="mt-1 font-mono text-[9px] uppercase text-muted-foreground">open</p></div><div className="p-5"><p className="font-mono text-2xl font-bold text-primary">{dashboard.tasks.dueThisWeek}</p><p className="mt-1 font-mono text-[9px] uppercase text-muted-foreground">due this week</p></div><div className="p-5"><p className="font-mono text-2xl font-bold text-destructive">{dashboard.tasks.overdue}</p><p className="mt-1 font-mono text-[9px] uppercase text-muted-foreground">overdue</p></div></div></section>
      <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">recent activity</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">Latest workspace operations</p></div><div className="divide-y divide-border">{dashboard.recentActivity.length === 0 ? <p className="p-5 font-mono text-xs text-muted-foreground">No workspace activity recorded yet.</p> : dashboard.recentActivity.slice(0, 6).map((item) => <div key={item.id} className="flex items-start gap-3 px-5 py-3"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><div className="min-w-0 flex-1"><p className="font-mono text-xs">{item.action.replaceAll("_", " ")}</p><p className="mt-1 truncate text-[10px] text-muted-foreground">{item.details || "Workspace operation"} · {item.actor || "System"}</p></div><time className="shrink-0 font-mono text-[9px] text-muted-foreground">{timeLabel(item.createdAt)}</time></div>)}</div></section>
    </div>
  </section>;
}

function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    changed_community_role: "changed a role for",
    created_community: "created",
    created_community_category: "created",
    created_community_channel: "created",
    created_workspace_department: "created",
    created_workspace_location: "created",
    created_workspace_task: "created",
    created_workspace_team: "created",
    invited_workspace_employee: "invited",
    accepted_workspace_invitation: "accepted",
    resent_workspace_invitation: "resent",
    offboarded_employee: "offboarded",
    transferred_workspace_ownership: "transferred ownership of",
    published_community_announcement: "published",
    published_workspace_policy: "published",
    scheduled_community_announcement: "scheduled",
    updated_community_category: "updated",
    updated_community_settings: "updated",
    updated_employee_status: "updated",
    assigned_employee_organization: "assigned",
    assigned_employee_team: "assigned",
    removed_employee_team: "removed",
    updated_workspace_task: "updated",
    uploaded_document_version: "uploaded",
    commented_on_workspace_task: "commented on",
  };
  return labels[action] ?? action.replaceAll("_", " ");
}

function BusinessAuditCenter({ detail, setError }: { detail: CommunityDetail; setError: (value: string) => void }) {
  const [payload, setPayload] = useState<BusinessActivityPayload>({ entries: [], actions: [] });
  const [userId, setUserId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [action, setAction] = useState("");
  const [resource, setResource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams();
    if (userId) query.set("userId", userId);
    if (locationId) query.set("locationId", locationId);
    if (departmentId) query.set("departmentId", departmentId);
    if (action) query.set("action", action);
    if (resource.trim()) query.set("resource", resource.trim());
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    setLoading(true);
    api<BusinessActivityPayload>(`/communities/${detail.community.id}/activity${query.size ? `?${query.toString()}` : ""}`).then((next) => {
      if (!cancelled) setPayload(next);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load business activity");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [detail.community.id, userId, locationId, departmentId, action, resource, from, to, setError]);

  const resetFilters = () => {
    setUserId("");
    setLocationId("");
    setDepartmentId("");
    setAction("");
    setResource("");
    setFrom("");
    setTo("");
  };

  return <section className="space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="font-mono text-[10px] uppercase tracking-[.18em] text-primary">business activity</p><h2 className="mt-2 font-mono text-xl font-bold">Activity / Audit Center</h2><p className="mt-1 text-sm text-muted-foreground">Review who changed what in this workspace, with the original action timestamp.</p></div>
      <span className="font-mono text-[10px] text-muted-foreground">{payload.entries.length} entries shown</span>
    </div>
    <div className="grid gap-2 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 xl:grid-cols-4">
      <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">User</span><select value={userId} onChange={(event) => setUserId(event.target.value)} className="h-9 w-full rounded border border-input bg-background px-2 font-mono text-xs"><option value="">All users</option>{detail.employees.map((employee) => <option key={employee.userId} value={employee.userId}>{employee.displayName}</option>)}</select></label>
      <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">Location</span><select value={locationId} onChange={(event) => setLocationId(event.target.value)} className="h-9 w-full rounded border border-input bg-background px-2 font-mono text-xs"><option value="">All locations</option>{detail.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
      <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">Department</span><select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} className="h-9 w-full rounded border border-input bg-background px-2 font-mono text-xs"><option value="">All departments</option>{detail.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
      <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">Action</span><select value={action} onChange={(event) => setAction(event.target.value)} className="h-9 w-full rounded border border-input bg-background px-2 font-mono text-xs"><option value="">All actions</option>{payload.actions.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}</select></label>
      <label className="space-y-1 sm:col-span-2 xl:col-span-2"><span className="font-mono text-[9px] uppercase text-muted-foreground">Resource</span><input value={resource} onChange={(event) => setResource(event.target.value)} placeholder="Search resource name, type, or ID" className="h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs" /></label>
      <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">Date from</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-9 w-full rounded border border-input bg-background px-2 font-mono text-xs" /></label>
      <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">Date to</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-9 w-full rounded border border-input bg-background px-2 font-mono text-xs" /></label>
      <div className="flex items-end sm:col-span-2 xl:col-span-4"><button onClick={resetFilters} className="rounded border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:bg-muted">clear filters</button></div>
    </div>
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">audit trail</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">Workspace-scoped manager history</p></div>
      {loading ? <div className="space-y-3 p-5"><div className="h-10 animate-pulse rounded bg-muted" /><div className="h-10 animate-pulse rounded bg-muted" /><div className="h-10 animate-pulse rounded bg-muted" /></div> : payload.entries.length === 0 ? <p className="p-5 font-mono text-xs text-muted-foreground">No activity matches these filters.</p> : <div className="divide-y divide-border">{payload.entries.map((entry) => {
        const resourceLabel = entry.targetLabel ?? entry.resourceType ?? "workspace";
        return <div key={entry.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
          <div className="min-w-0 flex-1"><p className="font-mono text-xs leading-5"><span className="font-bold">{entry.actor ?? "System"}</span>{" "}{auditActionLabel(entry.action)}{" "}<span className="text-secondary-foreground">{resourceLabel}</span></p><p className="mt-1 truncate text-[10px] text-muted-foreground">{entry.details || `${entry.resourceType ?? "workspace"} ${entry.resourceId ?? ""}`}</p></div>
          <time className="shrink-0 font-mono text-[9px] text-muted-foreground">{activityDateTimeFormatter.format(new Date(entry.createdAt))}</time>
        </div>;
      })}</div>}
    </section>
  </section>;
}

type BusinessDocument = {
  id: number;
  folderId: number | null;
  title: string;
  description: string;
  category: string;
  visibility: string;
  targetUserId: string | null;
  requiresAcknowledgement: boolean;
  expiresAt: string | null;
  updatedAt: string;
  acknowledgedAt: string | null;
  acknowledgementCount: number;
  downloadCount: number;
  versions: Array<{ id: number; version: number; fileName: string; contentType: string; fileSize: number; createdAt: string }>;
  permissions?: Array<{ userId: string; permission: string }>;
};
type DocumentsPayload = { folders: Array<{ id: number; parentId: number | null; name: string }>; documents: BusinessDocument[]; canManage: boolean };

export function DocumentCenter({ detail, working, setWorking, setNotice, setError }: { detail: CommunityDetail; working: boolean; setWorking: (value: boolean) => void; setNotice: (value: string) => void; setError: (value: string) => void }) {
  const [payload, setPayload] = useState<DocumentsPayload>({ folders: [], documents: [], canManage: detail.canManage });
  const [documentLoadError, setDocumentLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState("");
  const [category, setCategory] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [documentCategory, setDocumentCategory] = useState("company");
  const [visibility, setVisibility] = useState("company");
  const [targetUserId, setTargetUserId] = useState("");
  const [documentFolderId, setDocumentFolderId] = useState("");
  const [requiresAcknowledgement, setRequiresAcknowledgement] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [permissionUserId, setPermissionUserId] = useState("");
  const [permissionRole, setPermissionRole] = useState("viewer");
  const documentRequestRef = useRef(0);
  const loadDocuments = async (signal?: AbortSignal) => {
    const requestId = ++documentRequestRef.current;
    try {
      const next = await api<DocumentsPayload>(`/communities/${detail.community.id}/documents?q=${encodeURIComponent(query)}${folderId ? `&folderId=${folderId}` : ""}`, { signal });
      if (requestId === documentRequestRef.current) {
        setPayload(next);
        setDocumentLoadError("");
      }
    } catch (reason) {
      if (signal?.aborted || requestId !== documentRequestRef.current) return;
      const message = reason instanceof Error ? reason.message : "Could not load documents";
      setDocumentLoadError(message);
      setError(message);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadDocuments(controller.signal), 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [detail.community.id, query, folderId]);
  const createFolder = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/document-folders`, { method: "POST", body: JSON.stringify({ name: folderName, parentId: folderId || null }) });
      setFolderName("");
      setNotice("Document folder created.");
      await loadDocuments();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create folder"); }
    finally { setWorking(false); }
  };
  const uploadDocument = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) { setError("Choose a document file first."); return; }
    setWorking(true);
    try {
      const upload = await api<{ uploadURL: string; objectPath: string }>("/storage/uploads/request-url", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type, workspaceId: detail.community.id, resourceType: "document", resourceId: "new" }) });
      const uploaded = await fetch(upload.uploadURL, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
      if (!uploaded.ok) throw new Error("Document upload failed.");
      await api(`/communities/${detail.community.id}/documents`, { method: "POST", body: JSON.stringify({ title, description, category: documentCategory, visibility, targetUserId: visibility === "employee" ? targetUserId : null, folderId: documentFolderId || null, requiresAcknowledgement, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, objectPath: upload.objectPath, fileName: file.name, contentType: file.type || "application/octet-stream", fileSize: file.size }) });
      setTitle(""); setDescription(""); setFile(null); setExpiresAt(""); setRequiresAcknowledgement(false); setNotice("Document uploaded."); await loadDocuments();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not upload document"); }
    finally { setWorking(false); }
  };
  const acknowledge = async (documentId: number) => {
    setWorking(true);
    try { await api(`/communities/${detail.community.id}/documents/${documentId}/acknowledge`, { method: "POST" }); setNotice("Document acknowledged."); await loadDocuments(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not acknowledge document"); }
    finally { setWorking(false); }
  };
  const uploadVersion = async (documentId: number, nextFile: File) => {
    setWorking(true);
    try {
      const upload = await api<{ uploadURL: string; objectPath: string }>("/storage/uploads/request-url", { method: "POST", body: JSON.stringify({ name: nextFile.name, size: nextFile.size, contentType: nextFile.type, workspaceId: detail.community.id, resourceType: "document", resourceId: documentId }) });
      const uploaded = await fetch(upload.uploadURL, { method: "PUT", headers: { "content-type": nextFile.type || "application/octet-stream" }, body: nextFile });
      if (!uploaded.ok) throw new Error("Document version upload failed.");
      await api(`/communities/${detail.community.id}/documents/${documentId}/versions`, { method: "POST", body: JSON.stringify({ objectPath: upload.objectPath, fileName: nextFile.name, contentType: nextFile.type || "application/octet-stream", fileSize: nextFile.size }) });
      setNotice("New document version uploaded.");
      await loadDocuments();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not upload document version"); }
    finally { setWorking(false); }
  };
  const grantPermission = async (documentId: number) => {
    if (!permissionUserId) return;
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/documents/${documentId}/permissions`, { method: "POST", body: JSON.stringify({ userId: permissionUserId, permission: permissionRole }) });
      setPermissionUserId("");
      setNotice("Document permission granted.");
      await loadDocuments();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not grant document permission"); }
    finally { setWorking(false); }
  };
  const visibleDocuments = category === "all" ? payload.documents : payload.documents.filter((document) => document.category === category);
  return <section className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">knowledge base</p><h2 className="mt-2 font-mono text-xl font-bold">Business documents</h2><p className="mt-1 text-sm text-muted-foreground">Keep policies, procedures, training, forms, and employee records organized.</p></div><span className="font-mono text-[10px] text-muted-foreground">{payload.documents.length} document{payload.documents.length === 1 ? "" : "s"}</span></div>
    <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-card p-4"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search documents…" className="h-9 min-w-[220px] flex-1 rounded border border-input bg-background px-3 font-mono text-xs" /><select value={folderId} onChange={(event) => setFolderId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">All folders</option>{payload.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><select value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="all">All categories</option><option value="policies">Policies</option><option value="procedures">Procedures</option><option value="training">Training</option><option value="forms">Forms</option><option value="employee">Employee documents</option><option value="company">Company documents</option></select>{payload.canManage && <button onClick={() => setShowCreate((value) => !value)} className="rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">{showCreate ? "close editor" : "add document"}</button>}</div>
    {payload.canManage && showCreate && <div className="grid gap-5 xl:grid-cols-2"><form onSubmit={uploadDocument} className="rounded-xl border border-border bg-card p-5"><h3 className="font-mono text-sm font-bold">upload document</h3><div className="mt-4 grid gap-3"><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Document title" className="h-9 rounded border border-input bg-background px-3 font-mono text-xs" /><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" className="min-h-20 rounded border border-input bg-background px-3 py-2 font-mono text-xs" /><div className="grid gap-3 sm:grid-cols-2"><select value={documentCategory} onChange={(event) => setDocumentCategory(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="policies">Policies</option><option value="procedures">Procedures</option><option value="training">Training</option><option value="forms">Forms</option><option value="employee">Employee documents</option><option value="company">Company documents</option></select><select value={documentFolderId} onChange={(event) => setDocumentFolderId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">No folder</option>{payload.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><select value={visibility} onChange={(event) => setVisibility(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="company">Everyone in workspace</option><option value="managers">Managers only</option><option value="employee">One employee</option><option value="private">Explicit permissions</option></select>{visibility === "employee" && <select required value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Choose employee</option>{detail.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select>}</div><label className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><input type="checkbox" checked={requiresAcknowledgement} onChange={(event) => setRequiresAcknowledgement(event.target.checked)} /> require acknowledgment</label><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} aria-label="Document expiration" className="h-9 rounded border border-input bg-background px-3 font-mono text-xs" /><input required type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="h-9 rounded border border-input bg-background px-2 py-1.5 font-mono text-[10px]" /><button disabled={working} className="rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">upload document</button></div></form><form onSubmit={createFolder} className="rounded-xl border border-border bg-card p-5"><h3 className="font-mono text-sm font-bold">organize folders</h3><p className="mt-1 text-xs text-muted-foreground">Create folders for recurring operating materials.</p><div className="mt-4 flex gap-2"><input required value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="Folder name" className="h-9 min-w-0 flex-1 rounded border border-input bg-background px-3 font-mono text-xs" /><button disabled={working} className="rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">create</button></div><div className="mt-5 space-y-2">{payload.folders.map((folder) => <button type="button" key={folder.id} onClick={() => setFolderId(String(folder.id))} className={`block w-full rounded border px-3 py-2 text-left font-mono text-xs ${folderId === String(folder.id) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>/ {folder.name}</button>)}</div></form></div>}
     <div className="grid gap-4 md:grid-cols-2">{documentLoadError ? <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-8 font-mono text-xs text-destructive md:col-span-2">{documentLoadError}</div> : <>{visibleDocuments.map((document) => { const latest = document.versions[0]; const expired = document.expiresAt ? new Date(document.expiresAt) <= new Date() : false; return <article key={document.id} className="rounded-xl border border-border bg-card p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-mono text-[9px] uppercase tracking-[.15em] text-primary">{document.category} · {document.visibility}</p><h3 className="mt-2 truncate font-mono text-sm font-bold">{document.title}</h3><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{document.description || "No description provided."}</p></div><span className={`rounded px-2 py-1 font-mono text-[9px] uppercase ${expired ? "bg-destructive/10 text-destructive" : "bg-chart-4/10 text-chart-4"}`}>{expired ? "expired" : "current"}</span></div><div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground"><span>v{latest?.version ?? 0}</span><span>{document.versions.length} version{document.versions.length === 1 ? "" : "s"}</span><span>{document.downloadCount} download{document.downloadCount === 1 ? "" : "s"}</span>{document.requiresAcknowledgement && <span>{document.acknowledgementCount} acknowledged</span>}</div>{latest && <a href={`/api/communities/${detail.community.id}/documents/${document.id}/download/${latest.id}`} target="_blank" rel="noreferrer" className="mt-4 block truncate rounded border border-border px-3 py-2 font-mono text-xs text-primary hover:bg-muted">{latest.fileName}</a>}{payload.canManage && <label className="mt-3 block font-mono text-[10px] text-muted-foreground">upload new version<input type="file" onChange={(event) => { const nextFile = event.target.files?.[0]; if (nextFile) void uploadVersion(document.id, nextFile); }} className="mt-1 block h-8 w-full rounded border border-input bg-background px-2 py-1 font-mono text-[9px]" /></label>}{document.requiresAcknowledgement && !document.acknowledgedAt && !expired && <button disabled={working} onClick={() => void acknowledge(document.id)} className="mt-3 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">acknowledge document</button>}<div className="mt-3 space-y-1">{document.versions.slice(1).map((version) => <a key={version.id} href={`/api/communities/${detail.community.id}/documents/${document.id}/download/${version.id}`} target="_blank" rel="noreferrer" className="block truncate font-mono text-[10px] text-muted-foreground hover:text-primary">v{version.version} · {version.fileName}</a>)}</div>{payload.canManage && <div className="mt-4 border-t border-border pt-3"><p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">grant explicit access</p><div className="mt-2 flex gap-2"><select value={permissionUserId} onChange={(event) => setPermissionUserId(event.target.value)} className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-[9px]"><option value="">employee</option>{detail.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select><select value={permissionRole} onChange={(event) => setPermissionRole(event.target.value)} className="h-8 rounded border border-input bg-background px-2 font-mono text-[9px]"><option value="viewer">viewer</option><option value="editor">editor</option><option value="acknowledger">acknowledger</option></select><button type="button" disabled={working || !permissionUserId} onClick={() => void grantPermission(document.id)} className="rounded bg-primary px-2 py-1 font-mono text-[9px] font-bold text-primary-foreground disabled:opacity-50">grant</button></div></div>}</article>; })}{visibleDocuments.length === 0 && <div className="rounded-xl border border-dashed border-border p-8 font-mono text-xs text-muted-foreground md:col-span-2">No documents match this search.</div>}</>}</div>
    {documentLoadError && <button type="button" onClick={() => setDocumentLoadError("")} className="sr-only" aria-label="Dismiss error">Dismiss document error</button>}
  </section>;
}

function AdminDeleteButton({ label, working, onDelete }: { label: string; working: boolean; onDelete: () => void }) {
  return <button type="button" disabled={working} onClick={onDelete} className="inline-flex items-center gap-1 rounded border border-destructive/40 px-2 py-1 font-mono text-[9px] text-destructive hover:bg-destructive/10 disabled:opacity-50"><Trash2 className="h-3 w-3" />{label}</button>;
}

function AnnouncementCenter({ detail, working, setWorking, setNotice, setError, onRefresh }: { detail: CommunityDetail; working: boolean; setWorking: (value: boolean) => void; setNotice: (value: string) => void; setError: (value: string) => void; onRefresh: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audienceType, setAudienceType] = useState("company");
  const [departmentId, setDepartmentId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [requiresAcknowledgement, setRequiresAcknowledgement] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const createAnnouncement = async (event: FormEvent) => {
    event.preventDefault();
    const selectedFiles = files;
    setWorking(true);
    try {
      const announcement = await api<CommunityDetail["announcements"][number]>(`/communities/${detail.community.id}/announcements`, {
        method: "POST",
        body: JSON.stringify({
          title: title || "Announcement",
          body,
          audienceType,
          departmentId: audienceType === "department" ? departmentId : null,
          locationId: audienceType === "location" ? locationId : null,
          teamId: audienceType === "team" ? teamId : null,
          recipientId: audienceType === "individual" ? recipientId : null,
          requiresAcknowledgement,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      for (const file of selectedFiles) {
        const upload = await api<{ uploadURL: string; objectPath: string }>("/storage/uploads/request-url", {
          method: "POST",
          body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type, workspaceId: detail.community.id, resourceType: "announcement", resourceId: announcement.id }),
        });
        const uploaded = await fetch(upload.uploadURL, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
        if (!uploaded.ok) throw new Error(`Could not upload ${file.name}`);
        await api(`/communities/${detail.community.id}/announcements/${announcement.id}/attachments`, {
          method: "POST",
          body: JSON.stringify({ objectPath: upload.objectPath, fileName: file.name, contentType: file.type || "application/octet-stream", fileSize: file.size }),
        });
      }
      setTitle("");
      setBody("");
      setAudienceType("company");
      setDepartmentId("");
      setLocationId("");
      setTeamId("");
      setRecipientId("");
      setRequiresAcknowledgement(false);
      setScheduledAt("");
      setExpiresAt("");
      setFiles([]);
      setNotice("Announcement created.");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create announcement");
    } finally {
      setWorking(false);
    }
  };
  const openAnnouncement = async (announcementId: number) => {
    setSelectedId(announcementId);
    try {
      await api(`/communities/${detail.community.id}/announcements/${announcementId}/read`, { method: "POST" });
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not mark announcement as read");
    }
  };
  const acknowledge = async (announcementId: number) => {
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/announcements/${announcementId}/acknowledge`, { method: "POST" });
      setNotice("Announcement acknowledged.");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not acknowledge announcement");
    } finally {
      setWorking(false);
    }
  };
  const selected = detail.announcements.find((announcement) => announcement.id === selectedId) ?? null;
  const audienceLabel: Record<string, string> = { company: "Company-wide", department: "Department", location: "Location", team: "Team", individual: "Individual" };
  return <section className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">communications</p><h2 className="mt-2 font-mono text-xl font-bold">Announcements</h2><p className="mt-1 text-sm text-muted-foreground">Keep every location aligned with targeted, trackable updates.</p></div><span className="font-mono text-[10px] text-muted-foreground">{detail.announcements.length} history record{detail.announcements.length === 1 ? "" : "s"}</span></div>
    {detail.canManage && <form onSubmit={createAnnouncement} className="rounded-xl border border-border bg-card p-5">
      <h3 className="font-mono text-sm font-bold">create announcement</h3>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Announcement title" className="h-9 rounded border border-input bg-background px-3 font-mono text-xs md:col-span-2" />
        <textarea required value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write the announcement…" className="min-h-24 rounded border border-input bg-background px-3 py-2 font-mono text-xs md:col-span-2" />
        <select value={audienceType} onChange={(event) => setAudienceType(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="company">Company-wide</option><option value="department">Department</option><option value="location">Location</option><option value="team">Team</option><option value="individual">Individual</option></select>
        {audienceType === "department" && <select required value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Choose department</option>{detail.departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        {audienceType === "location" && <select required value={locationId} onChange={(event) => setLocationId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Choose location</option>{detail.locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        {audienceType === "team" && <select required value={teamId} onChange={(event) => setTeamId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Choose team</option>{detail.teams.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        {audienceType === "individual" && <select required value={recipientId} onChange={(event) => setRecipientId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Choose employee</option>{detail.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select>}
        <label className="flex items-center gap-2 rounded border border-border px-3 font-mono text-[10px] text-muted-foreground"><input type="checkbox" checked={requiresAcknowledgement} onChange={(event) => setRequiresAcknowledgement(event.target.checked)} /> required acknowledgment</label>
        <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs" aria-label="Schedule announcement" />
        <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs" aria-label="Announcement expiration" />
        <input type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} className="h-9 min-w-0 rounded border border-input bg-background px-2 py-1.5 font-mono text-[10px] md:col-span-2" />
      </div>
      <div className="mt-2 flex flex-wrap gap-3 font-mono text-[9px] text-muted-foreground"><span>Schedule and expiration are optional.</span>{files.length > 0 && <span>{files.length} attachment{files.length === 1 ? "" : "s"} selected</span>}</div>
      <button disabled={working} className="mt-4 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">publish announcement</button>
    </form>}
    <div className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
      <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">announcement history</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">Audience, schedule, receipts, and acknowledgement state</p></div><div className="divide-y divide-border">{detail.announcements.map((announcement) => <button key={announcement.id} onClick={() => void openAnnouncement(announcement.id)} className={`block w-full px-5 py-4 text-left hover:bg-muted/40 ${selectedId === announcement.id ? "bg-muted/40" : ""}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-mono text-xs font-bold">{announcement.title}</p><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{announcement.body}</p></div><span className="rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary">{audienceLabel[announcement.audienceType] ?? announcement.audienceType}</span></div><div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground"><span>by {announcement.author}</span><span>{announcement.status}</span><span>{announcement.readCount} read</span>{announcement.requiresAcknowledgement && <span>{announcement.acknowledgementCount} acknowledged</span>}{announcement.scheduledAt && <span>scheduled {new Date(announcement.scheduledAt).toLocaleString()}</span>}{announcement.expiresAt && <span>expires {new Date(announcement.expiresAt).toLocaleDateString()}</span>}</div></button>)}{detail.announcements.length === 0 && <EmptyAdminState label="No announcements yet." />}</div></section>
      <section className="rounded-xl border border-border bg-card">{!selected ? <div className="p-6"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">announcement details</p><p className="mt-3 text-sm text-muted-foreground">Select an announcement to view its full history and receipts.</p></div> : <div className="p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-mono text-sm font-bold">{selected.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{selected.body}</p></div>{selected.requiresAcknowledgement && <span className={`shrink-0 rounded px-2 py-1 font-mono text-[9px] uppercase ${selected.acknowledgedAt ? "bg-chart-4/10 text-chart-4" : "bg-primary/10 text-primary"}`}>{selected.acknowledgedAt ? "acknowledged" : "acknowledgment required"}</span>}</div><p className="mt-4 font-mono text-[10px] text-muted-foreground">Published by {selected.author} · {new Date(selected.createdAt).toLocaleString()} · {selected.readCount} read receipt{selected.readCount === 1 ? "" : "s"}{selected.requiresAcknowledgement ? ` · ${selected.acknowledgementCount} acknowledgements` : ""}</p><div className="mt-5 space-y-2">{selected.attachments.map((attachment) => <a key={attachment.id} href={`/api/communities/${detail.community.id}/announcements/${selected.id}/attachments/${attachment.id}`} target="_blank" rel="noreferrer" className="block rounded border border-border/70 px-3 py-2 font-mono text-xs text-primary hover:bg-muted">{attachment.fileName}<span className="ml-2 text-[9px] text-muted-foreground">{Math.ceil(attachment.fileSize / 1024)} KB</span></a>)}</div>{selected.requiresAcknowledgement && !selected.acknowledgedAt && <button disabled={working} onClick={() => void acknowledge(selected.id)} className="mt-5 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">acknowledge announcement</button>}</div>}</section>
    </div>
  </section>;
}

function TaskBoard({ detail, working, setWorking, setNotice, setError, onRefresh }: { detail: CommunityDetail; working: boolean; setWorking: (value: boolean) => void; setNotice: (value: string) => void; setError: (value: string) => void; onRefresh: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueDate, setDueDate] = useState("");
  const [taskSearch, setTaskSearch] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [taskDetails, setTaskDetails] = useState(new Map<number, CommunityDetail["tasks"][number]>());
  const [comment, setComment] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  useEffect(() => {
    setSelectedTaskId(null);
    setTaskDetails(new Map());
  }, [detail.community.id]);
  const loadTaskDetail = async (taskId: number, force = false) => {
    if (!force && taskDetails.has(taskId)) return;
    const task = await api<CommunityDetail["tasks"][number]>(`/communities/${detail.community.id}/tasks/${taskId}`);
    setTaskDetails((current) => new Map(current).set(taskId, task));
  };
  const selectTask = async (taskId: number) => {
    setSelectedTaskId(taskId);
    try {
      await loadTaskDetail(taskId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load task details");
    }
  };
  const refreshTaskData = async () => {
    await onRefresh();
    setTaskDetails(new Map());
    if (selectedTaskId !== null) await loadTaskDetail(selectedTaskId, true);
  };
  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    const selectedFiles = files;
    setWorking(true);
    try {
      const task = await api<CommunityDetail["tasks"][number]>(`/communities/${detail.community.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          assignedTo: assignedTo || null,
          departmentId: departmentId || null,
          locationId: locationId || null,
          priority,
          dueDate: dueDate ? `${dueDate}T23:59:59.000Z` : null,
        }),
      });
      for (const file of selectedFiles) {
        const upload = await api<{ uploadURL: string; objectPath: string }>(
          "/storage/uploads/request-url",
          { method: "POST", body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type, workspaceId: detail.community.id, resourceType: "task", resourceId: task.id }) },
        );
        const uploaded = await fetch(upload.uploadURL, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
        if (!uploaded.ok) throw new Error(`Could not upload ${file.name}`);
        await api(`/communities/${detail.community.id}/tasks/${task.id}/attachments`, {
          method: "POST",
          body: JSON.stringify({ objectPath: upload.objectPath, fileName: file.name, contentType: file.type || "application/octet-stream", fileSize: file.size }),
        });
      }
      setTitle("");
      setDescription("");
      setAssignedTo("");
      setDepartmentId("");
      setLocationId("");
      setPriority("medium");
      setDueDate("");
      setFiles([]);
      setNotice("Task created.");
       await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create task");
    } finally {
      setWorking(false);
    }
  };
  const updateStatus = async (taskId: number, status: string) => {
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setNotice("Task status updated.");
       await refreshTaskData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update task");
    } finally {
      setWorking(false);
    }
  };
  const addComment = async (event: FormEvent, taskId: number) => {
    event.preventDefault();
    if (!comment.trim()) return;
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify({ body: comment.trim() }) });
      setComment("");
       await refreshTaskData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add task comment");
    } finally {
      setWorking(false);
    }
  };
  const visibleTasks = detail.tasks.filter((task) => {
    const assignee = detail.members.find((member) => member.id === task.assignedTo);
    const department = detail.departments.find((item) => item.id === task.departmentId);
    const location = detail.locations.find((item) => item.id === task.locationId);
    return [task.title, task.description, task.status, task.priority, assignee?.displayName, department?.name, location?.name]
      .filter(Boolean).join(" ").toLowerCase().includes(taskSearch.trim().toLowerCase());
  });
  const selectedTask = selectedTaskId === null ? null : taskDetails.get(selectedTaskId) ?? detail.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const statusLabel: Record<string, string> = { todo: "To Do", in_progress: "In Progress", waiting: "Waiting", completed: "Completed", cancelled: "Cancelled" };
  return <section className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">work management</p><h2 className="mt-2 font-mono text-xl font-bold">Tasks</h2><p className="mt-1 text-sm text-muted-foreground">Coordinate work across employees, departments, and locations.</p></div>
      <input value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="Search tasks…" className="h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs sm:w-64" />
    </div>
    {detail.canManage && <form onSubmit={createTask} className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-3"><div><h3 className="font-mono text-sm font-bold">create task</h3><p className="mt-1 font-mono text-[10px] text-muted-foreground">Assign the work before it gets lost in chat.</p></div><span className="font-mono text-[9px] uppercase text-muted-foreground">{detail.tasks.length} total</span></div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" className="h-9 rounded border border-input bg-background px-3 font-mono text-xs md:col-span-2" />
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" className="min-h-20 rounded border border-input bg-background px-3 py-2 font-mono text-xs md:col-span-2" />
        <select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Assign to employee</option>{detail.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select>
        <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Department</option>{detail.departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select value={locationId} onChange={(event) => setLocationId(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Location</option>{detail.locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select value={priority} onChange={(event) => setPriority(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs"><option value="low">Low priority</option><option value="medium">Medium priority</option><option value="high">High priority</option><option value="urgent">Urgent</option></select>
        <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="h-9 rounded border border-input bg-background px-3 font-mono text-xs" />
        <input type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} className="h-9 min-w-0 rounded border border-input bg-background px-2 py-1.5 font-mono text-[10px] md:col-span-2" />
      </div>
      {files.length > 0 && <p className="mt-2 font-mono text-[10px] text-muted-foreground">{files.length} attachment{files.length === 1 ? "" : "s"} selected</p>}
      <button disabled={working} className="mt-4 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">create task</button>
    </form>}
     <div className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
       <section className="rounded-xl border border-border bg-card">
         <div className="divide-y divide-border">{visibleTasks.map((task) => { const assignee = detail.members.find((member) => member.id === task.assignedTo); const department = detail.departments.find((item) => item.id === task.departmentId); const location = detail.locations.find((item) => item.id === task.locationId); return <button key={task.id} onClick={() => void selectTask(task.id)} className={`block w-full px-5 py-4 text-left hover:bg-muted/40 ${selectedTaskId === task.id ? "bg-muted/40" : ""}`}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-mono text-xs font-bold">{task.title}</p><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description || "No description."}</p></div><span className={`shrink-0 rounded px-2 py-1 font-mono text-[9px] uppercase ${task.priority === "urgent" ? "bg-destructive/15 text-destructive" : "bg-primary/10 text-primary"}`}>{task.priority}</span></div><div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground"><span>{statusLabel[task.status] ?? task.status}</span><span>{assignee?.displayName ?? "Unassigned"}</span>{department && <span>{department.name}</span>}{location && <span>{location.name}</span>}{task.dueDate && <span>due {new Date(task.dueDate).toLocaleDateString()}</span>}</div></button>; })}{visibleTasks.length === 0 && <EmptyAdminState label={taskSearch ? "No tasks match that search." : "No tasks yet."} />}</div>
      </section>
      <section className="rounded-xl border border-border bg-card">
        {!selectedTask ? <div className="p-6"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">task details</p><p className="mt-3 text-sm text-muted-foreground">Select a task to view comments and attachments.</p></div> : <div><div className="border-b border-border p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-mono text-sm font-bold">{selectedTask.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{selectedTask.description || "No description."}</p></div>{detail.canManage && <select disabled={working} value={selectedTask.status} onChange={(event) => void updateStatus(selectedTask.id, event.target.value)} className="rounded border border-border bg-background px-2 py-1 font-mono text-[9px]"><option value="todo">To Do</option><option value="in_progress">In Progress</option><option value="waiting">Waiting</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>}</div></div><div className="p-5"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">attachments</p><div className="mt-3 space-y-2">{selectedTask.attachments.map((attachment) => <a key={attachment.id} href={`/api/communities/${detail.community.id}/tasks/${selectedTask.id}/attachments/${attachment.id}`} target="_blank" rel="noreferrer" className="block rounded border border-border/70 px-3 py-2 font-mono text-xs text-primary hover:bg-muted">{attachment.fileName}<span className="ml-2 text-[9px] text-muted-foreground">{Math.ceil(attachment.fileSize / 1024)} KB</span></a>)}{selectedTask.attachments.length === 0 && <p className="text-xs text-muted-foreground">No attachments.</p>}</div><p className="mt-5 font-mono text-[10px] uppercase tracking-[.16em] text-primary">comments</p><div className="mt-3 space-y-3">{selectedTask.comments.map((item) => <div key={item.id} className="rounded border border-border/70 p-3"><p className="font-mono text-[10px]">{item.author}<span className="ml-2 text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span></p><p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{item.body}</p></div>)}{selectedTask.comments.length === 0 && <p className="text-xs text-muted-foreground">No comments yet.</p>}</div><form onSubmit={(event) => void addComment(event, selectedTask.id)} className="mt-4 flex gap-2"><input required value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment" className="h-9 min-w-0 flex-1 rounded border border-input bg-background px-3 font-mono text-xs" /><button disabled={working} className="rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">comment</button></form></div></div>}
      </section>
    </div>
  </section>;
}

function OrganizationPanel({ detail, working, setWorking, setNotice, setError, onRefresh }: { detail: CommunityDetail; working: boolean; setWorking: (value: boolean) => void; setNotice: (value: string) => void; setError: (value: string) => void; onRefresh: () => Promise<void> }) {
  const [department, setDepartment] = useState("");
  const [location, setLocation] = useState("");
  const [team, setTeam] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteToken, setInviteToken] = useState("");
  const [ownershipTarget, setOwnershipTarget] = useState("");
  const [policyTitle, setPolicyTitle] = useState("");
  const [policyBody, setPolicyBody] = useState("");
  const [directorySearch, setDirectorySearch] = useState("");
  const mutate = async (path: string, body: unknown, message: string) => {
    setWorking(true);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setNotice(message);
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update workspace organization");
    } finally {
      setWorking(false);
    }
  };
  const updateEmployee = async (employeeId: string, employmentStatus: string) => {
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/employees/${employeeId}`, { method: "PATCH", body: JSON.stringify({ employmentStatus }) });
      setNotice("Employee status updated.");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update employee status");
    } finally {
      setWorking(false);
    }
  };
  const updateOrganization = async (employeeId: string, body: { departmentId?: number | null; locationId?: number | null; managerId?: string | null }) => {
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/employees/${employeeId}/organization`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setNotice("Employee organization assignment updated.");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update employee organization");
    } finally {
      setWorking(false);
    }
  };
  const updateTeamMembership = async (teamId: number, employeeId: string, assigned: boolean) => {
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/teams/${teamId}/members/${employeeId}`, {
        method: assigned ? "PUT" : "DELETE",
        ...(assigned ? { body: JSON.stringify({ role: "member", status: "active" }) } : {}),
      });
      setNotice(assigned ? "Employee added to team." : "Employee removed from team.");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update team membership");
    } finally {
      setWorking(false);
    }
  };
  const createInvitation = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    try {
      const created = await api<{ invitationToken: string }>(`/communities/${detail.community.id}/invitations`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setInviteToken(created.invitationToken);
      setInviteEmail("");
      setNotice("Invitation created. Share the one-time token with the employee.");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create employee invitation");
    } finally {
      setWorking(false);
    }
  };
  const resendInvitation = async (invitationId: number) => {
    setWorking(true);
    try {
      const resent = await api<{ invitationToken: string }>(`/communities/${detail.community.id}/invitations/${invitationId}/resend`, { method: "POST", body: "{}" });
      setInviteToken(resent.invitationToken);
      setNotice("Invitation resent. Share the new one-time token with the employee.");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not resend invitation");
    } finally {
      setWorking(false);
    }
  };
  const offboardEmployee = async (employeeId: string, displayName: string) => {
    if (!window.confirm(`Offboard ${displayName}? This immediately revokes workspace channels, teams, and roles.`)) return;
    await updateEmployee(employeeId, "terminated");
  };
  const transferOwnership = async (event: FormEvent) => {
    event.preventDefault();
    if (!ownershipTarget || !window.confirm("Transfer workspace ownership? You will become a workspace admin.")) return;
    setWorking(true);
    try {
      await api(`/communities/${detail.community.id}/transfer-ownership`, { method: "POST", body: JSON.stringify({ userId: ownershipTarget }) });
      setOwnershipTarget("");
      setNotice("Workspace ownership transferred.");
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not transfer workspace ownership");
    } finally {
      setWorking(false);
    }
  };
  const filteredEmployees = detail.employees.filter((employee) => {
    const departmentName = detail.departments.find((item) => item.id === employee.departmentId)?.name ?? "";
    const locationName = detail.locations.find((item) => item.id === employee.locationId)?.name ?? "";
    const roleNames = detail.assignments.filter((item) => item.userId === employee.userId).map((item) => item.role).join(" ");
    const searchable = [
      employee.displayName,
      employee.username,
      employee.jobTitle,
      departmentName,
      locationName,
      roleNames,
      employee.presenceStatus,
      employee.employmentStatus,
    ].join(" ").toLowerCase();
    return searchable.includes(directorySearch.trim().toLowerCase());
  });
  return <section className="space-y-5">
    {detail.canManage && <div className="grid gap-5 xl:grid-cols-3">
      <form onSubmit={(event) => { event.preventDefault(); void mutate(`/communities/${detail.community.id}/departments`, { name: department }, "Department created."); setDepartment(""); }} className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-mono text-sm font-bold">departments</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{detail.departments.length} departments</p>
        <input required value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="Operations" className="mt-4 h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs" />
        <button disabled={working} className="mt-3 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">add department</button>
        <div className="mt-4 space-y-2">{detail.departments.map((item) => <div key={item.id} className="rounded border border-border/70 px-3 py-2 font-mono text-xs">{item.name}<span className="ml-2 text-[9px] text-muted-foreground">{item.status}</span></div>)}</div>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); void mutate(`/communities/${detail.community.id}/locations`, { name: location }, "Location created."); setLocation(""); }} className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-mono text-sm font-bold">locations</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{detail.locations.length} locations</p>
        <input required value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Downtown office" className="mt-4 h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs" />
        <button disabled={working} className="mt-3 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">add location</button>
        <div className="mt-4 space-y-2">{detail.locations.map((item) => <div key={item.id} className="rounded border border-border/70 px-3 py-2 font-mono text-xs">{item.name}<span className="ml-2 text-[9px] text-muted-foreground">{item.timezone}</span></div>)}</div>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); void mutate(`/communities/${detail.community.id}/teams`, { name: team }, "Team created."); setTeam(""); }} className="rounded-xl border border-border bg-card p-5">
        <h2 className="font-mono text-sm font-bold">teams</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{detail.teams.length} teams</p>
        <input required value={team} onChange={(event) => setTeam(event.target.value)} placeholder="Field service team" className="mt-4 h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs" />
        <button disabled={working} className="mt-3 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">add team</button>
        <div className="mt-4 space-y-2">{detail.teams.map((item) => <div key={item.id} className="rounded border border-border/70 px-3 py-2 font-mono text-xs">{item.name}<span className="ml-2 text-[9px] text-muted-foreground">{item.status}</span></div>)}</div>
      </form>
    </div>}
    <div className="grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
       <section className="rounded-xl border border-border bg-card">
         <div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">company directory</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{filteredEmployees.length} of {detail.employees.length} employees · search by name, position, department, location, role, or status</p><input value={directorySearch} onChange={(event) => setDirectorySearch(event.target.value)} placeholder="Search employees…" className="mt-4 h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs" /></div>
          <div className="divide-y divide-border">{filteredEmployees.map((employee) => {
            const departmentName = detail.departments.find((item) => item.id === employee.departmentId)?.name;
            const locationName = detail.locations.find((item) => item.id === employee.locationId)?.name;
            const role = detail.assignments.find((item) => item.userId === employee.userId && item.scopeType === "community")?.role ?? "member";
            const online = employee.presenceStatus === "online";
            const employeeTeams = detail.teams.filter((item) => employee.teamIds.includes(item.id));
            const eligibleManagers = detail.employees.filter((item) => item.userId !== employee.userId && item.employmentStatus === "active");
            return <div key={employee.userId} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-chart-4" : "bg-muted-foreground/40"}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs font-bold">{employee.displayName}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{employee.jobTitle || "Employee"}{departmentName && ` · ${departmentName}`}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">Location: {locationName || "Unassigned"} · Teams: {employeeTeams.map((item) => item.name).join(", ") || "Unassigned"} · Status: {online ? "Online" : "Offline"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-muted px-2 py-1 font-mono text-[9px] uppercase text-muted-foreground">{role.replaceAll("_", " ")}</span>
                  <span className="rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary">{employee.employmentStatus}</span>
                  {detail.canManage && <select disabled={working} value={employee.employmentStatus} onChange={(event) => void updateEmployee(employee.userId, event.target.value)} className="rounded border border-border bg-background px-2 py-1 font-mono text-[9px]"><option value="onboarding">onboarding</option><option value="active">active</option><option value="leave">leave</option><option value="offboarding">offboarding</option><option value="terminated">terminated</option></select>}
                  {detail.canManage && employee.employmentStatus !== "terminated" && <button disabled={working} onClick={() => void offboardEmployee(employee.userId, employee.displayName)} className="rounded border border-destructive/30 px-2 py-1 font-mono text-[9px] text-destructive hover:bg-destructive/10">offboard</button>}
                </div>
              </div>
              {detail.canManageOrganization && employee.employmentStatus !== "terminated" && <div className="mt-4 grid gap-2 rounded-lg border border-primary/15 bg-primary/5 p-3 sm:grid-cols-3">
                <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">Department</span><select disabled={working} value={employee.departmentId ?? ""} onChange={(event) => void updateOrganization(employee.userId, { departmentId: event.target.value ? Number(event.target.value) : null })} className="h-8 w-full rounded border border-input bg-background px-2 font-mono text-[10px]"><option value="">Unassigned</option>{detail.departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">Location</span><select disabled={working} value={employee.locationId ?? ""} onChange={(event) => void updateOrganization(employee.userId, { locationId: event.target.value ? Number(event.target.value) : null })} className="h-8 w-full rounded border border-input bg-background px-2 font-mono text-[10px]"><option value="">Unassigned</option>{detail.locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label className="space-y-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">Manager</span><select disabled={working} value={employee.managerId ?? ""} onChange={(event) => void updateOrganization(employee.userId, { managerId: event.target.value || null })} className="h-8 w-full rounded border border-input bg-background px-2 font-mono text-[10px]"><option value="">Unassigned</option>{eligibleManagers.map((item) => <option key={item.userId} value={item.userId}>{item.displayName}</option>)}</select></label>
                <div className="sm:col-span-3"><span className="font-mono text-[9px] uppercase text-muted-foreground">Teams</span><div className="mt-2 flex flex-wrap gap-2">{detail.teams.length === 0 ? <span className="font-mono text-[10px] text-muted-foreground">Create a team first.</span> : detail.teams.map((item) => <label key={item.id} className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1 font-mono text-[10px]"><input type="checkbox" disabled={working} checked={employee.teamIds.includes(item.id)} onChange={(event) => void updateTeamMembership(item.id, employee.userId, event.target.checked)} />{item.name}</label>)}</div></div>
              </div>}
            </div>;
          })}{filteredEmployees.length === 0 && <EmptyAdminState label={directorySearch ? "No employees match that search." : "No employees yet."} />}</div>
      </section>
      {detail.canManage && <div className="space-y-5">
        <form onSubmit={createInvitation} className="rounded-xl border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">invite employee</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{detail.invitations.filter((item) => item.status === "pending").length} pending invitations</p><div className="mt-4 grid gap-2"><input required type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="employee@company.com" className="h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs" /><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)} className="h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs"><option value="employee">Employee</option><option value="contractor">Contractor</option><option value="member">Member</option></select></div><button disabled={working} className="mt-3 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">create invitation</button>{inviteToken && <div className="mt-4 rounded border border-primary/30 bg-primary/5 p-3"><p className="font-mono text-[9px] uppercase tracking-wider text-primary">one-time invitation token</p><code className="mt-2 block break-all text-[10px] text-foreground">{inviteToken}</code><p className="mt-2 text-[10px] leading-4 text-muted-foreground">Share this token securely. The recipient must be signed in with the invited email address before joining the private workspace.</p></div>}<div className="mt-4 space-y-2 border-t border-border pt-4">{detail.invitations.slice(0, 5).map((invitation) => <div key={invitation.id} className="flex items-center justify-between gap-3 rounded border border-border/70 px-3 py-2"><div className="min-w-0"><p className="truncate font-mono text-[10px]">{invitation.email}</p><p className="mt-1 font-mono text-[9px] text-muted-foreground">{invitation.role} · {invitation.status}{invitation.status === "pending" && ` · expires ${new Date(invitation.expiresAt).toLocaleDateString()}`}</p></div>{invitation.status !== "accepted" && <button type="button" disabled={working} onClick={() => void resendInvitation(invitation.id)} className="shrink-0 rounded border border-border px-2 py-1 font-mono text-[9px] text-muted-foreground hover:bg-muted">resend</button>}</div>)}</div></form>
        <form onSubmit={(event) => { event.preventDefault(); void mutate(`/communities/${detail.community.id}/policies`, { title: policyTitle, body: policyBody }, "Workspace policy published."); setPolicyTitle(""); setPolicyBody(""); }} className="rounded-xl border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">workspace policy</h2><input required value={policyTitle} onChange={(event) => setPolicyTitle(event.target.value)} placeholder="Safety policy" className="mt-4 h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs" /><textarea required value={policyBody} onChange={(event) => setPolicyBody(event.target.value)} placeholder="Policy details" className="mt-3 min-h-20 w-full rounded border border-input bg-background px-3 py-2 font-mono text-xs" /><button disabled={working} className="mt-3 rounded bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">publish policy</button><div className="mt-4 space-y-2">{detail.policies.slice(0, 3).map((policy) => <div key={policy.id} className="rounded border border-border/70 p-2"><p className="font-mono text-xs">{policy.title} <span className="text-[9px] text-muted-foreground">v{policy.version}</span></p><p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">{policy.body}</p></div>)}</div></form>
        <form onSubmit={transferOwnership} className="rounded-xl border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">ownership</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Transfer control to an existing workspace member.</p><select required value={ownershipTarget} onChange={(event) => setOwnershipTarget(event.target.value)} className="mt-4 h-9 w-full rounded border border-input bg-background px-3 font-mono text-xs"><option value="">Choose new owner</option>{detail.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select><button disabled={working || !ownershipTarget} className="mt-3 rounded border border-destructive/30 px-3 py-2 font-mono text-[10px] font-bold text-destructive disabled:opacity-50">transfer ownership</button></form>
      </div>}
    </div>
  </section>;
}

function DeveloperConsole() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [config, setConfig] = useState<AppConfig>(defaultAppConfig);
  const [releases, setReleases] = useState<DeveloperRelease[]>([]);
  const [section, setSection] = useState<"overview" | "content" | "releases">("overview");
  const [draft, setDraft] = useState(defaultAppConfig);
  const [releaseDraft, setReleaseDraft] = useState({ version: "", title: "", notes: "" });
  const [announcement, setAnnouncement] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadReleases = async () => {
    try {
      const nextReleases = await api<DeveloperRelease[]>("/developer/releases");
      setReleases(nextReleases);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load release history");
    }
  };

  const load = async () => {
    try {
      const nextStatus = await api<AdminStatus>("/admin/status");
      setStatus(nextStatus);
      if (!nextStatus.isAdmin) return;
      const [nextConfig, nextReleases] = await Promise.allSettled([
        api<AppConfig>("/developer/settings"),
        api<DeveloperRelease[]>("/developer/releases"),
      ]);
      if (nextConfig.status === "fulfilled") {
        setConfig(nextConfig.value);
        setDraft(nextConfig.value);
      } else {
        setError(nextConfig.reason instanceof Error ? nextConfig.reason.message : "Could not load developer settings");
      }
      if (nextReleases.status === "fulfilled") {
        setReleases(nextReleases.value);
      } else {
        setError(nextReleases.reason instanceof Error ? nextReleases.reason.message : "Could not load release history");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load developer studio");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (status?.isAdmin && section === "releases") void loadReleases();
  }, [status?.isAdmin, section]);

  const saveContent = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    try {
      const saved = await api<AppConfig>("/developer/settings", { method: "PATCH", body: JSON.stringify(draft) });
      setConfig(saved);
      setDraft(saved);
      setNotice("Public application content saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save content");
    } finally {
      setWorking(false);
    }
  };
  const sendAnnouncement = async (event: FormEvent) => {
    event.preventDefault();
    if (!announcement.trim()) return;
    setWorking(true);
    try {
      await api("/admin/announcements", { method: "POST", body: JSON.stringify({ body: announcement.trim() }) });
      setAnnouncement("");
      setNotice("Announcement sent to every account.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send announcement");
    } finally {
      setWorking(false);
    }
  };
  const createRelease = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    try {
      const created = await api<DeveloperRelease>("/developer/releases", { method: "POST", body: JSON.stringify(releaseDraft) });
      setReleases((items) => [created, ...items]);
      setReleaseDraft({ version: "", title: "", notes: "" });
      setNotice("Release draft created.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create release");
    } finally {
      setWorking(false);
    }
  };
  const changeReleaseStatus = async (release: DeveloperRelease, nextStatus: DeveloperRelease["status"]) => {
    setWorking(true);
    try {
      const updated = await api<DeveloperRelease>(`/developer/releases/${release.id}/status`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
      setReleases((items) => items.map((item) => item.id === updated.id ? updated : item));
      setNotice(`Release ${updated.version} is now ${updated.status}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update release");
    } finally {
      setWorking(false);
    }
  };
  const publishReleaseAnnouncement = async (release: DeveloperRelease) => {
    setWorking(true);
    try {
      await api(`/developer/releases/${release.id}/announcement`, { method: "PATCH", body: JSON.stringify({ status: "published" }) });
      setNotice(`Announcement for ${release.version} is now live.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not publish release announcement");
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-background font-mono text-sm text-muted-foreground">loading developer studio…</div>;
  if (error && !status) return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 font-mono text-sm text-destructive">{error}</div>;
  if (!status?.isAdmin) return <div className="min-h-[100dvh] bg-background px-5 py-8 text-foreground sm:px-10"><div className="mx-auto max-w-2xl"><a href={`${basePath}/chat`} className="font-mono text-xs text-muted-foreground hover:text-primary">← return to relay</a><div className="mt-16 rounded-2xl border border-border bg-card p-8"><Zap className="h-8 w-8 text-primary" /><p className="mt-6 font-mono text-[10px] uppercase tracking-[.18em] text-primary">developer access</p><h1 className="mt-2 font-mono text-3xl font-bold">This studio is owner-only.</h1><p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">The developer studio is restricted to the platform owner and developer account.</p></div></div></div>;

  const published = releases.find((release) => release.status === "published");
  const nav: Array<[typeof section, string, LucideIcon]> = [["overview", "studio overview", LayoutDashboard], ["content", "content & settings", Settings], ["releases", "release desk", Zap]];
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur"><div className="mx-auto flex min-h-[76px] max-w-[1500px] items-center justify-between gap-4 px-4 sm:px-7"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Zap className="h-5 w-5" /></div><div><p className="font-mono text-sm font-bold">relay / developer studio</p><p className="font-mono text-[9px] uppercase tracking-[.18em] text-muted-foreground">owner workspace · build, review, publish</p></div></div><div className="flex items-center gap-2"><a href={`${basePath}/admin`} className="hidden rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:bg-muted sm:block">operations control room</a><a href={`${basePath}/chat`} className="rounded-md border border-border px-3 py-2 font-mono text-[10px] text-muted-foreground hover:bg-muted">back to chat</a></div></div></header>
      <main className="mx-auto grid max-w-[1500px] gap-5 px-4 py-5 sm:px-7 sm:py-7 lg:grid-cols-[220px_1fr]">
        <aside className="rounded-xl border border-border bg-card p-3"><p className="px-3 py-2 font-mono text-[9px] uppercase tracking-[.2em] text-muted-foreground">developer workspace</p><nav className="mt-2 space-y-1">{nav.map(([key, label, Icon]) => <button key={key} onClick={() => setSection(key)} className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left font-mono text-xs ${section === key ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon className="h-4 w-4" />{label}</button>)}</nav><div className="mt-8 border-t border-border px-3 pt-5"><p className="font-mono text-[9px] uppercase tracking-[.16em] text-muted-foreground">signed in as</p><p className="mt-3 truncate font-mono text-xs font-bold">{status.profile.displayName}</p><span className="mt-3 inline-flex rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary">owner / developer</span></div></aside>
        <section className="min-w-0">
          {error && <div className="mb-5 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}<button onClick={() => setError("")} className="ml-auto" aria-label="Dismiss error" title="Dismiss error"><X className="h-3.5 w-3.5" /></button></div>}
          {notice && <div className="mb-5 flex items-center gap-2 rounded-md border border-chart-4/30 bg-chart-4/10 p-3 font-mono text-xs text-chart-4"><CheckCircle2 className="h-4 w-4" />{notice}<button onClick={() => setNotice("")} className="ml-auto" aria-label="Dismiss notice" title="Dismiss notice"><X className="h-3.5 w-3.5" /></button></div>}
          <div className="mb-7"><p className="font-mono text-[10px] uppercase tracking-[.2em] text-primary">/{section}</p><h1 className="mt-2 font-mono text-2xl font-bold sm:text-3xl">{section === "overview" ? "The application, under your control." : section === "content" ? "Edit the public experience." : "Move updates from draft to published."}</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{section === "overview" ? "Keep product content, releases, and platform operations in separate owner-only workspaces." : section === "content" ? "Change landing-page messaging and send platform-wide announcements." : "Track release notes and review state before marking an application update as published."}</p></div>
          {section === "overview" && <div className="grid gap-5 xl:grid-cols-2"><div className="grid gap-3 sm:grid-cols-3 xl:col-span-2"><div className="rounded-lg border border-border bg-card p-4"><Zap className="h-4 w-4 text-primary" /><p className="mt-5 font-mono text-2xl font-bold">{published?.version ?? "none"}</p><p className="mt-1 font-mono text-[10px] uppercase text-muted-foreground">published release</p></div><div className="rounded-lg border border-border bg-card p-4"><Save className="h-4 w-4 text-primary" /><p className="mt-5 font-mono text-2xl font-bold">{releases.filter((item) => item.status === "draft").length}</p><p className="mt-1 font-mono text-[10px] uppercase text-muted-foreground">drafts</p></div><div className="rounded-lg border border-border bg-card p-4"><Radio className="h-4 w-4 text-primary" /><p className="mt-5 truncate font-mono text-2xl font-bold">{config.networkStatusLabel}</p><p className="mt-1 font-mono text-[10px] uppercase text-muted-foreground">landing status</p></div></div><section className="rounded-lg border border-border bg-card p-5"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">full owner access</p><h2 className="mt-3 font-mono text-lg font-bold">Build, edit, and operate Relay.</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Use this studio for the public experience and release workflow. Use the operations control room for accounts, roles, channels, audit history, and system health.</p><a href={`${basePath}/admin`} className="mt-5 inline-flex rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground">open operations control room</a></section><section className="rounded-lg border border-border bg-card p-5"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">current release</p><h2 className="mt-3 font-mono text-lg font-bold">{published ? `${published.version} · ${published.title}` : "No published release yet"}</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{published?.notes || "Create a release draft when you are ready to record an application update."}</p></section></div>}
          {section === "content" && <div className="grid gap-5 xl:grid-cols-2"><form onSubmit={saveContent} className="rounded-lg border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">landing page content</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Stored in the database and used by the public landing page.</p><div className="mt-5 space-y-3">{([["siteName", "site name"], ["landingEyebrow", "eyebrow"], ["networkStatusLabel", "network status"]] as const).map(([key, label]) => <label key={key} className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">{label}</span><input value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label>)}<label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">headline</span><textarea value={draft.landingTitle} onChange={(event) => setDraft({ ...draft, landingTitle: event.target.value })} className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">description</span><textarea value={draft.landingDescription} onChange={(event) => setDraft({ ...draft, landingDescription: event.target.value })} className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" /></label></div><button disabled={working} className="mt-4 flex items-center gap-2 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50"><Save className="h-3.5 w-3.5" />save public content</button></form><form onSubmit={sendAnnouncement} className="rounded-lg border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">platform announcement</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Send a notification to every account.</p><textarea required value={announcement} onChange={(event) => setAnnouncement(event.target.value)} className="mt-5 min-h-36 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder="Write the update for everyone…" /><button disabled={working} className="mt-4 flex items-center gap-2 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50"><Megaphone className="h-3.5 w-3.5" />send announcement</button></form></div>}
             {section === "releases" && <div className="space-y-5"><form onSubmit={createRelease} className="rounded-lg border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">create release draft</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Record the update, review it, then publish its release state.</p><div className="mt-5 grid gap-3 sm:grid-cols-[150px_1fr]"><input required value={releaseDraft.version} onChange={(event) => setReleaseDraft({ ...releaseDraft, version: event.target.value })} placeholder="v0.2.0" className="h-9 rounded-md border border-input bg-background px-3 font-mono text-xs" /><input required value={releaseDraft.title} onChange={(event) => setReleaseDraft({ ...releaseDraft, title: event.target.value })} placeholder="Release title" className="h-9 rounded-md border border-input bg-background px-3 font-mono text-xs" /></div><textarea value={releaseDraft.notes} onChange={(event) => setReleaseDraft({ ...releaseDraft, notes: event.target.value })} placeholder="What changed?" className="mt-3 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" /><button disabled={working} className="mt-3 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">save release draft</button></form><section className="rounded-lg border border-border bg-card"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-mono text-sm font-bold">release history</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{releases.length} tracked updates</p></div><button type="button" disabled={working} onClick={() => void loadReleases()} className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground hover:bg-muted disabled:opacity-50"><RefreshCw className="h-3 w-3" />refresh</button></div><div className="divide-y divide-border">{releases.map((release) => <div key={release.id} className="px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-sm font-bold">{release.version} · {release.title}</p><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{release.notes || "No release notes."}</p>{release.status === "published" && <div className={`mt-4 rounded-md border p-3 ${release.announcementId ? "border-primary/20 bg-primary/5" : "border-destructive/30 bg-destructive/10"}`}><p className={`font-mono text-[9px] uppercase tracking-[.14em] ${release.announcementId ? "text-primary" : "text-destructive"}`}>{release.announcementId ? "announcement draft ready" : "announcement missing"}</p><p className="mt-1 font-mono text-xs">Release {release.version}: {release.title}</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{release.announcementId ? (release.notes || `Release ${release.version} is ready for announcement review.`) : "The linked announcement is missing. Recreate it to keep this release visible to the company."}</p><button disabled={working} onClick={() => void publishReleaseAnnouncement(release)} className="mt-3 rounded bg-primary px-2.5 py-1.5 font-mono text-[9px] font-bold text-primary-foreground disabled:opacity-50">{release.announcementId ? "publish announcement" : "recreate and publish announcement"}</button></div>}</div><span className="rounded bg-muted px-2 py-1 font-mono text-[9px] uppercase text-muted-foreground">{release.status}</span></div><div className="mt-4 flex flex-wrap gap-2">{release.status === "draft" && <button disabled={working} onClick={() => void changeReleaseStatus(release, "review")} className="rounded border border-primary/30 px-2.5 py-1.5 font-mono text-[9px] text-primary">send for review</button>}{release.status === "review" && <><button disabled={working} onClick={() => void changeReleaseStatus(release, "draft")} className="rounded border border-border px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground">return to draft</button><button disabled={working} onClick={() => void changeReleaseStatus(release, "published")} className="rounded bg-primary px-2.5 py-1.5 font-mono text-[9px] font-bold text-primary-foreground">publish update</button></>}{release.status === "published" && <button disabled={working} onClick={() => void changeReleaseStatus(release, "archived")} className="rounded border border-border px-2.5 py-1.5 font-mono text-[9px] text-muted-foreground hover:bg-muted disabled:opacity-50">archive</button>}</div></div>)}{releases.length === 0 && <div className="p-6 font-mono text-xs text-muted-foreground">No releases have been recorded.</div>}</div></section></div>}
        </section>
      </main>
    </div>
  );
}

function InvitationAcceptance() {
  const [communityId, setCommunityId] = useState("");
  const [token, setToken] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      await api(`/communities/${Number(communityId)}/invitations/accept`, { method: "POST", body: JSON.stringify({ token }) });
      setNotice("Invitation accepted. Your employee profile is ready.");
      window.setTimeout(() => { window.location.assign(`${basePath}/chat`); }, 500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not accept invitation");
    } finally {
      setWorking(false);
    }
  };
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-5 py-10 text-foreground"><div className="w-full max-w-lg rounded-2xl border border-border bg-card p-7"><a href={`${basePath}/chat`} className="font-mono text-xs text-muted-foreground hover:text-primary">← return to relay</a><p className="mt-10 font-mono text-[10px] uppercase tracking-[.18em] text-primary">workspace invitation</p><h1 className="mt-2 font-mono text-2xl font-bold">Join a business workspace.</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Use the workspace number and one-time token while signed in with the verified email address that received the invitation.</p>{error && <p className="mt-4 rounded border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive">{error}</p>}{notice && <p className="mt-4 rounded border border-chart-4/30 bg-chart-4/10 p-3 font-mono text-xs text-chart-4">{notice}</p>}<form onSubmit={submit} className="mt-6 space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">workspace number</span><input required inputMode="numeric" value={communityId} onChange={(event) => setCommunityId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="42" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">invitation token</span><input required value={token} onChange={(event) => setToken(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="paste the one-time token" /></label><button disabled={working} className="w-full rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground disabled:opacity-50">{working ? "accepting…" : "accept invitation"}</button></form></div></div>;
}

function ChatGate() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<OnboardingState>("/onboarding").then(setState).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "Could not load your workspace");
    });
  }, []);
  if (error) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 font-mono text-sm text-destructive">{error}</div>;
  }
  if (!state) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background font-mono text-sm text-muted-foreground">checking your Relay setup…</div>;
  }
  if (state.nextStep !== "start") return <Redirect to="/onboarding" />;
  return <ChatApp />;
}

function OnboardingPage() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [community, setCommunity] = useState<CommunitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState("");
  const [services, setServices] = useState("");
  const [serviceArea, setServiceArea] = useState("");
  const [businessHours, setBusinessHours] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [inviteEmails, setInviteEmails] = useState("");
  const [inviteRole, setInviteRole] = useState("employee");
  const [inviteTokens, setInviteTokens] = useState<Array<{ email: string; token: string }>>([]);

  const refresh = async () => {
    const next = await api<OnboardingState>("/onboarding");
    setState(next);
    if (!next.ownerCommunity) {
      setCommunity(null);
      setError("Relay could not provision your free community. Please try again.");
      return;
    }
    setCommunity({
      ...next.ownerCommunity,
      description: "",
      rules: "",
      businessType: "community",
      services: "",
      serviceArea: "",
      businessHours: "",
      contactEmail: "",
      contactPhone: "",
      status: "active",
      isPrivate: false,
    });
    setName(next.ownerCommunity.name);
  };

  useEffect(() => {
    refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load onboarding")).finally(() => setLoading(false));
  }, []);

  const createCommunity = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      await api<CommunitySummary>("/communities", {
        method: "POST",
        body: JSON.stringify({ name, description, rules, services, serviceArea, businessHours, contactEmail, contactPhone, isPrivate: true, onboarding: true }),
      });
      setNotice("Your workspace is ready. Add the details your team needs.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create your workspace");
    } finally {
      setWorking(false);
    }
  };

  const configureCommunity = async (event: FormEvent) => {
    event.preventDefault();
    if (!community) return;
    setWorking(true);
    setError("");
    try {
      await api(`/communities/${community.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description, rules, services, serviceArea, businessHours, contactEmail, contactPhone }),
      });
      await api(`/onboarding/${community.id}/progress`, { method: "POST", body: JSON.stringify({ step: 2 }) });
      setNotice("Workspace details saved. Invite your first people.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save workspace details");
    } finally {
      setWorking(false);
    }
  };

  const finishOnboarding = async () => {
    if (!community) return;
    setWorking(true);
    setError("");
    try {
      await api(`/onboarding/${community.id}/progress`, { method: "POST", body: JSON.stringify({ step: 9 }) });
      window.location.assign(`${basePath}/chat`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not finish onboarding");
    } finally {
      setWorking(false);
    }
  };

  const invitePeople = async (event: FormEvent) => {
    event.preventDefault();
    if (!community) return;
    const emails = inviteEmails.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean);
    if (emails.length === 0) {
      await finishOnboarding();
      return;
    }
    setWorking(true);
    setError("");
    try {
      const created: Array<{ email: string; token: string }> = [];
      for (const email of emails) {
        const invitation = await api<{ invitationToken: string }>(`/communities/${community.id}/invitations`, {
          method: "POST",
          body: JSON.stringify({ email, role: inviteRole }),
        });
        created.push({ email, token: invitation.invitationToken });
      }
      setInviteTokens(created);
      setInviteEmails("");
      await api(`/onboarding/${community.id}/progress`, { method: "POST", body: JSON.stringify({ step: 9 }) });
      setNotice("Invitations created. Share each one-time token with its recipient.");
      setState((current) => current ? { ...current, nextStep: "start" } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create every invitation");
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <div className="flex min-h-[100dvh] items-center justify-center bg-background font-mono text-sm text-muted-foreground">preparing your Relay setup…</div>;
  if (state?.nextStep === "start") {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6"><div className="w-full max-w-lg rounded-2xl border border-border bg-card p-8"><CheckCircle2 className="h-8 w-8 text-chart-4" /><p className="mt-6 font-mono text-[10px] uppercase tracking-[.18em] text-primary">setup complete</p><h1 className="mt-2 font-mono text-3xl font-bold">Your Relay is ready.</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Your workspace has starter rooms and your first invitations are ready to share.</p>{inviteTokens.length > 0 && <div className="mt-6 space-y-2">{inviteTokens.map((item) => <div key={`${item.email}-${item.token}`} className="rounded-lg border border-border bg-background p-3 font-mono text-xs"><p className="text-muted-foreground">{item.email}</p><p className="mt-1 break-all text-primary">{item.token}</p></div>)}</div>}<button onClick={() => window.location.assign(`${basePath}/chat`)} className="mt-7 w-full rounded-md bg-primary py-3 font-mono text-xs font-bold text-primary-foreground">start using Relay</button></div></div>;
  }
  const step = state?.nextStep ?? "create";
  return <div className="min-h-[100dvh] bg-background px-5 py-8 text-foreground sm:px-10">
    <main className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-4"><div><p className="font-mono text-sm font-bold">relay / free community</p><p className="mt-1 font-mono text-[9px] uppercase tracking-[.18em] text-muted-foreground">your community is ready automatically</p></div><a href={`${basePath}/`} className="font-mono text-[10px] text-muted-foreground hover:text-primary">relay home</a></div>
      <div className="mt-10 rounded-lg border border-primary/30 bg-primary/10 p-4"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">free community</p><p className="mt-2 text-sm leading-6 text-muted-foreground">Relay created <span className="font-semibold text-foreground">{community?.name ?? "your community"}</span> with welcome and general rooms. No workspace setup is required.</p></div>
      {error && <div className="mt-6 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive"><AlertTriangle className="h-4 w-4" />{error}</div>}
      {notice && <div className="mt-6 flex items-center gap-2 rounded-md border border-chart-4/30 bg-chart-4/10 p-3 font-mono text-xs text-chart-4"><CheckCircle2 className="h-4 w-4" />{notice}</div>}
      {!community && <div className="mt-8 rounded-2xl border border-border bg-card p-6 font-mono text-sm text-muted-foreground">Preparing your free community…</div>}
      {community && step === "configure" && <form onSubmit={configureCommunity} className="mt-8 rounded-2xl border border-border bg-card p-6 sm:p-8"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-primary">step 02 / configure</p><h1 className="mt-2 font-mono text-3xl font-bold">Make it useful on day one.</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Add the context people need before they join. You can change any of this later.</p><div className="mt-7 space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">workspace name</span><input required value={name} onChange={(event) => setName(event.target.value)} className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" /></label><div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">services or focus</span><input value={services} onChange={(event) => setServices(event.target.value)} placeholder="Operations, design, support" className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">service area</span><input value={serviceArea} onChange={(event) => setServiceArea(event.target.value)} placeholder="Chicago and suburbs" className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">business hours</span><input value={businessHours} onChange={(event) => setBusinessHours(event.target.value)} placeholder="Mon–Fri, 8am–5pm" className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">contact email</span><input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label></div><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">rules and expectations</span><textarea value={rules} onChange={(event) => setRules(event.target.value)} className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" /></label></div><button disabled={working} className="mt-6 w-full rounded-md bg-primary py-3 font-mono text-xs font-bold text-primary-foreground disabled:opacity-50">{working ? "saving…" : "save and invite people"}</button></form>}
      {community && step === "invite" && <form onSubmit={invitePeople} className="mt-8 rounded-2xl border border-border bg-card p-6 sm:p-8"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-primary">optional / invite</p><h1 className="mt-2 font-mono text-3xl font-bold">Bring your people in.</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Enter email addresses to create member invitations. You can also skip this and start using your free community right away.</p><label className="mt-7 block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">email addresses</span><textarea value={inviteEmails} onChange={(event) => setInviteEmails(event.target.value)} placeholder="alex@example.com&#10;sam@example.com" className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" /></label><button disabled={working} className="mt-6 w-full rounded-md bg-primary py-3 font-mono text-xs font-bold text-primary-foreground disabled:opacity-50">{working ? "creating invitations…" : inviteEmails.trim() ? "create member invitations" : "skip and start using Relay"}</button></form>}
    </main>
  </div>;
}

function CommunityConsole() {
  const [, routeParams] = useRoute<{ id?: string }>("/communities/:id");
  const parsedCommunityId = routeParams?.id ? Number(routeParams.id) : NaN;
  const requestedCommunityId = Number.isSafeInteger(parsedCommunityId) && parsedCommunityId > 0 ? parsedCommunityId : null;
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
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
  const [newCommunityPrivate, setNewCommunityPrivate] = useState(true);
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
  const [newWorkspaceChannelPrivate, setNewWorkspaceChannelPrivate] = useState(false);
  const [ownerConfirmation, setOwnerConfirmation] = useState<OwnerConfirmation | null>(null);
  const [ownerActionError, setOwnerActionError] = useState("");

  const loadCommunities = async () => {
    const [nextPermissions, nextCommunities, me] = await Promise.all([
      api<PermissionSnapshot>("/permissions/me"),
      api<CommunitySummary[]>("/communities"),
      api<Profile>("/me"),
    ]);
    setPermissions(nextPermissions);
    setCurrentUserId(me.id);
    setCommunities(nextCommunities);
    setSelectedId((current) => current ?? requestedCommunityId ?? nextCommunities[0]?.id ?? null);
  };
  const loadDetail = async (id: number) => {
    const next = await api<CommunityDetail>(`/communities/${id}?view=summary`);
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
  }, [requestedCommunityId]);
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
         isPrivate: newCommunityPrivate,
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
       setNewCommunityPrivate(true);
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
  const runOwnerAction = async () => {
    if (!detail || !detail.isOwner || !ownerConfirmation) return;
    const pending = ownerConfirmation;
    const targetName = pending.kind === "remove-member" || pending.kind === "delete-account"
      ? detail.members.find((member) => member.id === pending.id)?.displayName ?? pending.label
      : pending.kind === "delete-channel"
        ? detail.channels.find((channel) => channel.id === pending.id)?.name ?? pending.label
        : detail.community.name;
    const confirmation = ownerConfirmationPhrase(pending.kind, targetName, detail.community.name);
    setWorking(true);
    setOwnerActionError("");
    try {
      if (pending.kind === "remove-member") {
        await api(`/communities/${detail.community.id}/members/${pending.id}`, { method: "DELETE", body: JSON.stringify({ confirmation }) });
        setNotice(`${pending.label} was removed from this workspace.`);
        await loadDetail(detail.community.id);
        await loadCommunities();
      } else if (pending.kind === "delete-account") {
        await api(`/communities/${detail.community.id}/members/${pending.id}/account`, { method: "DELETE", body: JSON.stringify({ confirmation }) });
        setNotice(`${pending.label}'s account was deleted everywhere.`);
        await loadDetail(detail.community.id);
        await loadCommunities();
      } else if (pending.kind === "delete-channel") {
        await api(`/communities/${detail.community.id}/channels/${pending.id}`, { method: "DELETE", body: JSON.stringify({ confirmation }) });
        setNotice(`${pending.label} deleted.`);
        await loadDetail(detail.community.id);
      } else {
        const deleted = await api<{ cleanupPending?: boolean }>(`/communities/${detail.community.id}`, { method: "DELETE", body: JSON.stringify({ confirmation }) });
        setOwnerConfirmation(null);
        setNotice(deleted.cleanupPending ? "Workspace deleted. Some storage cleanup is still pending." : "Workspace deleted.");
        await loadCommunities();
        window.setTimeout(() => {
          window.history.pushState({}, "", `${basePath}/communities`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, 300);
      }
      setOwnerConfirmation(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The owner action could not be completed.";
      setOwnerActionError(message);
      setError(message);
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
           isPrivate: newWorkspaceChannelPrivate,
        }),
      });
      setNewWorkspaceChannelName("");
      setNewWorkspaceChannelTopic("");
      setNewWorkspaceChannelDescription("");
      setNewWorkspaceChannelCategoryId("");
      setNewWorkspaceChannelPrivate(false);
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
  const deleteCommunityResource = async (resource: "categories" | "channels" | "announcements", id: number, label: string) => {
    if (!detail || !window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    setWorking(true);
    setError("");
    try {
      await api(`/communities/${detail.community.id}/${resource}/${id}`, { method: "DELETE" });
      setNotice(`${label} deleted.`);
      await loadDetail(detail.community.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not delete ${label}`);
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
          {error && <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive"><AlertTriangle className="h-4 w-4" />{error}<button onClick={() => setError("")} className="ml-auto" aria-label="Dismiss error" title="Dismiss error"><X className="h-3.5 w-3.5" /></button></div>}
          {notice && <div className="mb-4 flex items-center gap-2 rounded-md border border-chart-4/30 bg-chart-4/10 p-3 font-mono text-xs text-chart-4"><CheckCircle2 className="h-4 w-4" />{notice}<button onClick={() => setNotice("")} className="ml-auto" aria-label="Dismiss notification" title="Dismiss notification"><X className="h-3.5 w-3.5" /></button></div>}
          {!detail ? <div className="rounded-xl border border-border bg-card p-8"><Users className="h-6 w-6 text-primary" /><h1 className="mt-5 font-mono text-2xl font-bold">Choose a business.</h1><p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">Business owners and managers operate only inside assigned private workspaces. Platform settings stay with Admin / Developer accounts.</p></div> : <div className="space-y-5">
            <div className="rounded-xl border border-border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-primary">business workspace</p><h1 className="mt-2 font-mono text-2xl font-bold">{detail.community.name}</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{detail.community.description || "No business description yet."}</p></div><span className="rounded bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase text-primary">{detail.canManage ? "manage access" : "read access"}</span></div></div>
            {detail.canManage && <div className="grid gap-5 xl:grid-cols-2">
              <form onSubmit={saveSettings} className="rounded-xl border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">business settings</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Only assignments matching this workspace can change these values.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><input value={settings.name} onChange={(event) => setSettings({ ...settings, name: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="business name" /><input value={settings.contactEmail} onChange={(event) => setSettings({ ...settings, contactEmail: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="contact email" /><input value={settings.contactPhone} onChange={(event) => setSettings({ ...settings, contactPhone: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="contact phone" /><input value={settings.serviceArea} onChange={(event) => setSettings({ ...settings, serviceArea: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" placeholder="service area" /><input value={settings.services} onChange={(event) => setSettings({ ...settings, services: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs sm:col-span-2" placeholder="services offered" /><input value={settings.businessHours} onChange={(event) => setSettings({ ...settings, businessHours: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs sm:col-span-2" placeholder="business hours" /><input value={settings.description} onChange={(event) => setSettings({ ...settings, description: event.target.value })} className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs sm:col-span-2" placeholder="description" /><textarea value={settings.rules} onChange={(event) => setSettings({ ...settings, rules: event.target.value })} className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs sm:col-span-2" placeholder="policies and operating rules" /></div><button disabled={working} className="mt-4 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">save business settings</button></form>
              <form onSubmit={sendAnnouncement} className="rounded-xl border border-border bg-card p-5"><h2 className="font-mono text-sm font-bold">team announcement</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Send a visible notification to current business members.</p><textarea required value={announcement} onChange={(event) => setAnnouncement(event.target.value)} className="mt-4 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder="Write a short announcement" /><button disabled={working} className="mt-4 rounded-md bg-primary px-3 py-2 font-mono text-[10px] font-bold text-primary-foreground disabled:opacity-50">send announcement</button></form>
            </div>}
            <div className="grid gap-5 xl:grid-cols-2">
              <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">team members</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{detail.members.length} people in this workspace</p></div><div className="divide-y divide-border">{detail.members.map((member) => { const assignment = detail.assignments.find((item) => item.userId === member.id && item.scopeType === "community"); const role = assignment?.role ?? "member"; const isOwnerOrSelf = member.id === currentUserId || role === "workspace_owner"; return <div key={member.id} className="flex flex-wrap items-center gap-3 px-5 py-3"><div className={`h-2 w-2 rounded-full ${member.status === "online" ? "bg-chart-4" : "bg-muted-foreground/40"}`} /><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs">{member.displayName}</p><p className="font-mono text-[10px] text-muted-foreground">@{member.username}</p></div><span className="font-mono text-[9px] uppercase text-muted-foreground">{role.replaceAll("_", " ")}</span>{detail.canManage && <select disabled={working} value={role} onChange={(event) => void changeMemberRole(member.id, event.target.value)} className="rounded border border-border bg-background px-2 py-1 font-mono text-[9px]"><option value="member">member</option><option value="moderator">moderator</option><option value="manager">manager</option><option value="department_admin">community / department admin</option><option value="workspace_admin">workspace admin</option><option value="workspace_owner">workspace owner</option></select>}{detail.isOwner && !isOwnerOrSelf && <div className="flex flex-wrap gap-2"><button type="button" disabled={working} aria-label={`Remove ${member.username} from workspace`} onClick={() => { setOwnerActionError(""); setOwnerConfirmation({ kind: "remove-member", id: member.id, label: `@${member.username}`, phrase: member.username }); }} className="rounded border border-destructive/30 px-2 py-1 font-mono text-[9px] text-destructive">remove from workspace</button><button type="button" disabled={working} aria-label={`Delete ${member.username} account everywhere`} onClick={() => { setOwnerActionError(""); setOwnerConfirmation({ kind: "delete-account", id: member.id, label: `@${member.username}`, phrase: member.username }); }} className="rounded border border-destructive/30 px-2 py-1 font-mono text-[9px] text-destructive">delete account everywhere</button></div>}</div>; })}</div></section>
                 <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="font-mono text-sm font-bold">categories & channels</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">Create rooms directly inside an operating category.</p></div><div className="border-b border-border p-5"><div className="space-y-4">{detail.categories.map((category) => { const categoryChannels = detail.channels.filter((channel) => channel.categoryId === category.id); return <div key={category.id} className="rounded-md border border-border/70 p-3"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs text-secondary-foreground">{category.name}</p><p className="mt-1 text-[10px] text-muted-foreground">{category.description || "No description"}</p></div><span className="font-mono text-[9px] text-muted-foreground">{categoryChannels.length} room{categoryChannels.length === 1 ? "" : "s"}</span></div>{categoryChannels.length > 0 && <div className="mt-3 space-y-2 border-t border-border pt-3">{categoryChannels.map((channel) => <div key={channel.id} className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate font-mono text-xs text-foreground">{channel.name}</p><p className="truncate text-[10px] text-muted-foreground">{channel.topic || channel.description || "No topic set"}</p></div><span className="shrink-0 font-mono text-[9px] text-muted-foreground">{channel.isPrivate ? "private" : "public"}</span></div>)}</div>}</div>; })}{detail.categories.length === 0 && <p className="font-mono text-[10px] text-muted-foreground">No categories yet. Add one before creating a categorized room.</p>}{detail.channels.some((channel) => channel.categoryId === null) && <div className="rounded-md border border-dashed border-border p-3"><p className="font-mono text-[10px] uppercase tracking-[.14em] text-muted-foreground">uncategorized</p><div className="mt-2 space-y-1">{detail.channels.filter((channel) => channel.categoryId === null).map((channel) => <p key={channel.id} className="font-mono text-xs text-foreground">{channel.name} · {channel.isPrivate ? "private" : "public"}</p>)}</div></div>}</div>{detail.canManage && <><form onSubmit={createCategory} className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4"><input required value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="new category" className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-[10px]" /><input value={newCategoryDescription} onChange={(event) => setNewCategoryDescription(event.target.value)} placeholder="description" className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-[10px]" /><button disabled={working} className="rounded bg-primary px-2.5 py-1.5 font-mono text-[9px] font-bold text-primary-foreground disabled:opacity-50">add category</button></form><form onSubmit={createWorkspaceChannel} className="mt-4 space-y-2 border-t border-border pt-4"><p className="font-mono text-[10px] uppercase tracking-[.14em] text-primary">add a channel to a category</p><div className="grid gap-2 sm:grid-cols-2"><input required value={newWorkspaceChannelName} onChange={(event) => setNewWorkspaceChannelName(event.target.value)} placeholder="#channel-name" className="h-8 rounded border border-input bg-background px-2 font-mono text-[10px]" /><select required value={newWorkspaceChannelCategoryId} onChange={(event) => setNewWorkspaceChannelCategoryId(event.target.value)} className="h-8 rounded border border-input bg-background px-2 font-mono text-[10px]"><option value="">select category</option>{detail.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div><div className="grid gap-2 sm:grid-cols-2"><input value={newWorkspaceChannelTopic} onChange={(event) => setNewWorkspaceChannelTopic(event.target.value)} placeholder="topic" className="h-8 rounded border border-input bg-background px-2 font-mono text-[10px]" /><input value={newWorkspaceChannelDescription} onChange={(event) => setNewWorkspaceChannelDescription(event.target.value)} placeholder="description" className="h-8 rounded border border-input bg-background px-2 font-mono text-[10px]" /></div><label className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><input type="checkbox" checked={newWorkspaceChannelPrivate} onChange={(event) => setNewWorkspaceChannelPrivate(event.target.checked)} /> private channel (owner approval)</label><button disabled={working || detail.categories.length === 0} className="rounded bg-primary px-3 py-1.5 font-mono text-[9px] font-bold text-primary-foreground disabled:opacity-50">create categorized channel</button></form></>}</div></section>
             </div>
              {detail.isOwner && <><TestAccountsPanel detail={detail} setError={setError} setNotice={setNotice} /><section className="rounded-xl border border-destructive/30 bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-destructive">danger zone</p><h2 className="mt-2 font-mono text-sm font-bold">delete workspace</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">This permanently deletes every channel, member relationship, and business record in this workspace. This cannot be undone.</p></div><button type="button" disabled={working} onClick={() => { setOwnerActionError(""); setOwnerConfirmation({ kind: "delete-workspace", label: detail.community.name, phrase: detail.community.name }); }} className="rounded border border-destructive/40 px-3 py-2 font-mono text-[10px] font-bold text-destructive">delete workspace</button></div></section></>}
              {detail.canManage && <BusinessDashboard detail={detail} setError={setError} />}
              {detail.canManage && <BusinessAuditCenter detail={detail} setError={setError} />}
             {detail.isOwner && <section className="rounded-xl border border-destructive/30 bg-card p-5"><h2 className="font-mono text-sm font-bold">owner channel controls</h2><p className="mt-1 text-xs text-muted-foreground">Only the workspace owner can permanently delete a channel.</p><div className="mt-4 space-y-2">{detail.channels.map((channel) => <div key={channel.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-border/70 px-3 py-2"><span className="truncate font-mono text-xs">{channel.name}</span><button type="button" disabled={working} aria-label={`Delete channel ${channel.name}`} onClick={() => { setOwnerActionError(""); setOwnerConfirmation({ kind: "delete-channel", id: channel.id, label: channel.name, phrase: ownerConfirmationPhrase("delete-channel", channel.name, detail.community.name) }); }} className="rounded border border-destructive/40 px-2 py-1 font-mono text-[9px] text-destructive">delete channel</button></div>)}</div></section>}
             <DocumentCenter detail={detail} working={working} setWorking={setWorking} setNotice={setNotice} setError={setError} />
             <AnnouncementCenter detail={detail} working={working} setWorking={setWorking} setNotice={setNotice} setError={setError} onRefresh={() => loadDetail(detail.community.id)} />
             <TaskBoard detail={detail} working={working} setWorking={setWorking} setNotice={setNotice} setError={setError} onRefresh={() => loadDetail(detail.community.id)} />
             {(detail.canManage || detail.canManageOrganization) && <OrganizationPanel detail={detail} working={working} setWorking={setWorking} setNotice={setNotice} setError={setError} onRefresh={() => loadDetail(detail.community.id)} />}
             {detail.canManage && <section className="rounded-xl border border-destructive/30 bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[.16em] text-destructive">danger zone</p><h2 className="mt-2 font-mono text-sm font-bold">delete workspace resources</h2><p className="mt-1 text-xs text-muted-foreground">Deleting a category unassigns its channels. Deleting a channel removes its members, requests, messages, and invitations.</p></div><Trash2 className="h-5 w-5 text-destructive" /></div><div className="mt-5 grid gap-5 xl:grid-cols-3"><div><p className="font-mono text-[10px] uppercase text-muted-foreground">categories</p><div className="mt-2 space-y-2">{detail.categories.map((category) => <div key={category.id} className="flex items-center justify-between gap-2 rounded border border-border/70 px-3 py-2"><span className="truncate font-mono text-xs">{category.name}</span><AdminDeleteButton label="delete" working={working} onDelete={() => void deleteCommunityResource("categories", category.id, `category “${category.name}”`)} /></div>)}{detail.categories.length === 0 && <p className="mt-2 font-mono text-[10px] text-muted-foreground">No categories.</p>}</div></div><div><p className="font-mono text-[10px] uppercase text-muted-foreground">channels</p><div className="mt-2 space-y-2">{detail.channels.map((channel) => <div key={channel.id} className="flex items-center justify-between gap-2 rounded border border-border/70 px-3 py-2"><span className="truncate font-mono text-xs">{channel.name}</span><AdminDeleteButton label="delete" working={working} onDelete={() => void deleteCommunityResource("channels", channel.id, `channel “${channel.name}”`)} /></div>)}{detail.channels.length === 0 && <p className="mt-2 font-mono text-[10px] text-muted-foreground">No channels.</p>}</div></div><div><p className="font-mono text-[10px] uppercase text-muted-foreground">announcements</p><div className="mt-2 space-y-2">{detail.announcements.map((item) => <div key={item.id} className="flex items-center justify-between gap-2 rounded border border-border/70 px-3 py-2"><span className="truncate font-mono text-xs">{item.title}</span><AdminDeleteButton label="delete" working={working} onDelete={() => void deleteCommunityResource("announcements", item.id, `announcement “${item.title}”`)} /></div>)}{detail.announcements.length === 0 && <p className="mt-2 font-mono text-[10px] text-muted-foreground">No announcements.</p>}</div></div></div></section>}
           </div>}
        </section>
      </main>
       {newCommunityOpen && <Overlay title="Set up a business workspace" onClose={() => setNewCommunityOpen(false)}><form onSubmit={createCommunity} className="space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">business name</span><input autoFocus required value={newName} onChange={(event) => setNewName(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">visibility</span><select value={newCommunityPrivate ? "private" : "public"} onChange={(event) => setNewCommunityPrivate(event.target.value === "private")} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs"><option value="public">public workspace</option><option value="private">private workspace</option></select><span className="mt-1 block font-mono text-[9px] text-muted-foreground">Public workspaces can be discovered by all signed-in users. Private workspaces are limited to members and assigned roles.</span></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">description</span><input value={newDescription} onChange={(event) => setNewDescription(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">services</span><input value={newServices} onChange={(event) => setNewServices(event.target.value)} placeholder="HVAC, plumbing, electrical" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">service area</span><input value={newServiceArea} onChange={(event) => setNewServiceArea(event.target.value)} placeholder="Chicago and suburbs" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">contact email</span><input type="email" value={newContactEmail} onChange={(event) => setNewContactEmail(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">contact phone</span><input value={newContactPhone} onChange={(event) => setNewContactPhone(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label></div><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">business hours</span><input value={newBusinessHours} onChange={(event) => setNewBusinessHours(event.target.value)} placeholder="Mon–Fri, 8am–5pm" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">policies and rules</span><textarea value={newRules} onChange={(event) => setNewRules(event.target.value)} className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" /></label><button disabled={working} className="w-full rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground disabled:opacity-50">create business workspace</button></form></Overlay>}
       {ownerConfirmation && detail?.isOwner && <OwnerConfirmOverlay title={ownerConfirmation.kind === "remove-member" ? `Remove ${ownerConfirmation.label} from this workspace?` : ownerConfirmation.kind === "delete-account" ? `Delete ${ownerConfirmation.label}'s account everywhere?` : ownerConfirmation.kind === "delete-channel" ? `Delete ${ownerConfirmation.label}?` : "Delete this workspace permanently?"} description={ownerConfirmation.kind === "remove-member" ? "This removes the member from this workspace and revokes their workspace access. Their Relay account and other workspaces remain." : ownerConfirmation.kind === "delete-account" ? "This revokes the member's Clerk identity and removes their Relay access. Authored history is retained and attributed to [deleted user]. A 409 response means deletion is blocked because they belong to another owner's workspace." : ownerConfirmation.kind === "delete-channel" ? "This permanently deletes the channel, its messages, members, requests, and invitations." : "All channels, members, and business data will be permanently deleted."} phrase={ownerConfirmationPhrase(ownerConfirmation.kind, ownerConfirmation.kind === "remove-member" || ownerConfirmation.kind === "delete-account" ? detail.members.find((member) => member.id === ownerConfirmation.id)?.displayName ?? ownerConfirmation.label : ownerConfirmation.kind === "delete-channel" ? detail.channels.find((channel) => channel.id === ownerConfirmation.id)?.name ?? ownerConfirmation.label : detail.community.name, detail.community.name)} confirmLabel={ownerConfirmation.kind === "remove-member" ? "remove from workspace" : ownerConfirmation.kind === "delete-account" ? "delete account everywhere" : ownerConfirmation.kind === "delete-channel" ? "delete channel" : "delete workspace"} working={working} error={ownerActionError} onConfirm={() => void runOwnerAction()} onClose={() => { setOwnerConfirmation(null); setOwnerActionError(""); }} />}
    </div>
  );
}

function AuthRoutes() {
  return <Switch><Route path="/"><Show when="signed-in"><Redirect to="/chat" /></Show><Show when="signed-out"><Landing /></Show></Route><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/chat"><Show when="signed-in"><ChatGate /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route path="/onboarding"><Show when="signed-in"><OnboardingPage /></Show><Show when="signed-out"><Redirect to="/sign-in" /></Show></Route><Route path="/accept-invitation"><Show when="signed-in"><InvitationAcceptance /></Show><Show when="signed-out"><Redirect to="/sign-in" /></Show></Route><Route path="/communities/:id"><Show when="signed-in"><CommunityConsole /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route path="/communities"><Show when="signed-in"><CommunityConsole /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route path="/developer"><Show when="signed-in"><DeveloperConsole /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route path="/admin"><Show when="signed-in"><AdminConsole /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route component={NotFoundPage} /></Switch>;
}

function NotFoundPage() {
  return <main className="flex min-h-[100dvh] items-center justify-center bg-background px-6 text-foreground"><div className="max-w-md text-center"><p className="font-mono text-[10px] uppercase tracking-[.2em] text-primary">404 · route not found</p><h1 className="mt-3 font-mono text-3xl font-bold">Nothing here.</h1><p className="mt-4 text-sm leading-6 text-muted-foreground">That relay address does not exist.</p><a href={`${basePath}/`} className="mt-7 inline-block rounded-lg bg-primary px-4 py-2 font-mono text-xs font-bold text-primary-foreground">return home</a></div></main>;
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