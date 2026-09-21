import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Bell,
  Check,
  ChevronDown,
  Hash,
  LogOut,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Shield,
  Sparkles,
  UserRound,
  Users,
  X,
  Zap,
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
};
type Channel = { id: number; name: string; topic: string; ownerId: string; joined: boolean; memberCount: number };
type ChatMessage = {
  id: string;
  channelId?: number | null;
  body: string;
  kind: string;
  createdAt: string;
  sender: Profile | null;
  recipientId?: string | null;
};
type Member = Profile & { role: string; mutedUntil?: string | null };
type Notification = { id: number; type: string; body: string; readAt?: string | null; createdAt: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Something went wrong");
  return data as T;
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

function useRoomData(channelId: number | null, activeDm: Profile | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!channelId && !activeDm) return;
    let cancelled = false;
    setLoading(true);
    const promise = activeDm
      ? api<{ messages: ChatMessage[] }>(`/dm/${activeDm.id}/messages`)
      : api<{ messages: ChatMessage[] }>(`/channels/${channelId}/messages`);
    promise.then((data) => { if (!cancelled) setMessages(data.messages); }).catch(() => { if (!cancelled) setMessages([]); }).finally(() => { if (!cancelled) setLoading(false); });
    if (channelId && !activeDm) api<Member[]>(`/channels/${channelId}/members`).then((data) => { if (!cancelled) setMembers(data); }).catch(() => setMembers([]));
    return () => { cancelled = true; };
  }, [channelId, activeDm]);
  return { messages, setMessages, members, setMembers, loading };
}

function ChatApp() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
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
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [connection, setConnection] = useState("connecting");
  const room = useRoomData(currentChannelId, activeDm);
  const currentChannel = channels.find((channel) => channel.id === currentChannelId) ?? null;
  const actorRole = room.members.find((member) => member.id === profile?.id)?.role;
  const unread = notifications.filter((notification) => !notification.readAt).length;

  useEffect(() => {
    Promise.all([api<Profile>("/me"), api<Channel[]>("/channels"), api<Notification[]>("/notifications")]).then(([me, list, notices]) => {
      setProfile(me); setChannels(list); setNotifications(notices);
      const first = list.find((channel) => channel.joined) ?? list[0];
      if (first) setCurrentChannelId(first.id);
      if (first && !first.joined) api(`/channels/${first.id}/join`, { method: "POST", body: "{}" }).then(() => setChannels((items) => items.map((item) => item.id === first.id ? { ...item, joined: true } : item)));
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
          const data = JSON.parse(event.data) as { type: string; message?: ChatMessage; channel?: Channel; action?: string; user?: Profile };
          if (data.type === "message" && data.message?.channelId === currentChannelId) room.setMessages((items) => items.some((item) => item.id === data.message!.id) ? items : [...items, data.message!]);
          if (data.type === "dm" && data.message && activeDm && (data.message.sender?.id === activeDm.id || data.message.recipientId === activeDm.id)) room.setMessages((items) => items.some((item) => item.id === data.message!.id) ? items : [...items, data.message!]);
          if (data.type === "channel" && data.channel) setChannels((items) => items.map((item) => item.id === data.channel!.id ? { ...item, ...data.channel } : item));
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
  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    try {
      const sent = activeDm ? await api<ChatMessage>(`/dm/${activeDm.id}/messages`, { method: "POST", body: JSON.stringify({ body }) }) : await api<ChatMessage>(`/channels/${currentChannelId}/messages`, { method: "POST", body: JSON.stringify({ body }) });
      room.setMessages((items) => items.some((item) => item.id === sent.id) ? items : [...items, sent]);
    } catch (error) { setDraft(body); window.alert(error instanceof Error ? error.message : "Message could not be sent"); }
  };
  const joinChannel = async (channel: Channel) => {
    await api(`/channels/${channel.id}/join`, { method: "POST", body: "{}" });
    setChannels((items) => items.map((item) => item.id === channel.id ? { ...item, joined: true } : item));
    setCurrentChannelId(channel.id); setActiveDm(null);
  };
  const createChannel = async (event: FormEvent) => {
    event.preventDefault();
    const created = await api<Channel>("/channels", { method: "POST", body: JSON.stringify({ name: newChannelName, topic: newChannelTopic }) });
    setChannels((items) => [...items, { ...created, joined: true, memberCount: 1 }]);
    setCurrentChannelId(created.id); setNewChannelOpen(false); setNewChannelName(""); setNewChannelTopic("");
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
    const topic = window.prompt("Channel topic", currentChannel.topic);
    if (topic === null) return;
    const updated = await api<Channel>(`/channels/${currentChannel.id}`, { method: "PATCH", body: JSON.stringify({ topic }) });
    setChannels((items) => items.map((item) => item.id === updated.id ? { ...item, topic: updated.topic } : item));
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
          <button className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" onClick={() => setNewChannelOpen(true)} aria-label="Create channel"><Plus className="h-4 w-4" /></button>
        </div>
        <div className="border-b border-sidebar-border p-3"><div className="relative"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="find a room" className="h-9 w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 pl-9 pr-3 font-mono text-[11px] outline-none focus:border-primary" /></div></div>
        <div className="flex-1 overflow-y-auto px-2 py-4">
          <p className="mb-2 px-2 font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">public channels</p>
          <div className="space-y-1">{visibleChannels.map((channel) => <button key={channel.id} onClick={() => { setCurrentChannelId(channel.id); setActiveDm(null); }} className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left font-mono text-xs ${channel.id === currentChannelId && !activeDm ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"}`}><span className="flex items-center gap-2"><Hash className="h-3.5 w-3.5 text-primary/70" />{channel.name.slice(1)}</span><span className="text-[10px]">{channel.memberCount}</span></button>)}</div>
          <p className="mb-2 mt-7 px-2 font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">direct messages</p>
          <div className="relative"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="find a person" className="h-9 w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 pl-9 pr-3 font-mono text-[11px] outline-none focus:border-primary" /></div>
          {userResults.length > 0 && <div className="mt-2 space-y-1 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-1">{userResults.map((result) => <button key={result.id} onClick={() => { setActiveDm(result); setUserSearch(""); setUserResults([]); }} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-sidebar-accent"><Avatar user={result} size="sm" /><span className="min-w-0 truncate font-mono text-xs">{result.displayName}</span></button>)}</div>}
        </div>
        <button className="m-3 flex items-center gap-2 rounded-md bg-sidebar-accent/60 p-2.5 text-left" onClick={() => setPanel("profile")}><Avatar user={profile} size="sm" /><span className="min-w-0 flex-1 truncate"><span className="block font-mono text-xs">{profile.displayName}</span><span className="block font-mono text-[9px] text-muted-foreground">@{profile.username}</span></span><ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /></button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[76px] items-center justify-between border-b border-border bg-card/80 px-4 backdrop-blur sm:px-6">
          <div className="min-w-0">{activeDm ? <><p className="font-mono text-[10px] uppercase tracking-[.15em] text-secondary-foreground">direct message</p><h1 className="truncate font-mono text-base font-bold">@{activeDm.username}</h1></> : <><div className="flex items-center gap-2"><Hash className="h-4 w-4 text-primary" /><h1 className="font-mono text-base font-bold">{currentChannel?.name ?? "#lobby"}</h1><span className="rounded bg-chart-4/10 px-1.5 py-0.5 font-mono text-[9px] uppercase text-chart-4">public</span>{["owner", "moderator"].includes(actorRole ?? "") && <button onClick={editTopic} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-primary" title="Edit channel topic" aria-label="Edit channel topic"><Settings className="h-3.5 w-3.5" /></button>}</div><p className="mt-1 truncate text-[11px] text-muted-foreground">{currentChannel?.topic}</p></>}</div>
          <div className="flex items-center gap-1.5">
            <form onSubmit={searchHistory} className="hidden items-center gap-2 rounded-md border border-border bg-background px-2 sm:flex"><Search className="h-3.5 w-3.5 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="search history" className="h-8 w-28 bg-transparent font-mono text-[10px] outline-none" /></form>
            <button onClick={() => setPanel("notifications")} className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Notifications"><Bell className="h-4 w-4" />{unread > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />}</button>
            <button onClick={() => setShowMembers((value) => !value)} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Toggle members"><Users className="h-4 w-4" /></button>
            <button onClick={() => signOut({ redirectUrl: basePath || "/" })} className="hidden rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:block" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-3 py-5 sm:px-6">
              {room.loading ? <p className="font-mono text-xs text-muted-foreground">loading history…</p> : room.messages.length === 0 ? <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center"><MessageSquare className="mb-3 h-8 w-8 text-primary" /><p className="font-mono text-sm">the room is quiet</p><p className="mt-2 max-w-xs font-mono text-[11px] text-muted-foreground">Start the conversation and make the room yours.</p></div> : <div className="space-y-5">{room.messages.map((message) => <div key={message.id} className="flex gap-3"><Avatar user={message.sender} size="sm" /><div className="min-w-0"><div className="flex flex-wrap items-baseline gap-2"><span className="font-mono text-xs font-bold text-secondary-foreground">{message.sender?.displayName ?? "system"}</span><span className="font-mono text-[10px] text-muted-foreground">{timeLabel(message.createdAt)}</span></div><p className="mt-1 break-words text-sm leading-6 text-foreground/90">{message.body}</p></div></div>)}</div>}
            </div>
            <div className="border-t border-border bg-card/70 px-3 pb-4 pt-3 sm:px-6"><form onSubmit={sendMessage} className="flex items-end gap-2 rounded-lg border border-input bg-background p-2 focus-within:border-primary"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={1} maxLength={500} placeholder={activeDm ? `message @${activeDm.username}` : `message ${currentChannel?.name ?? "#lobby"}`} className="max-h-28 min-h-[28px] flex-1 resize-none bg-transparent px-2 py-1 font-mono text-xs outline-none placeholder:text-muted-foreground/60" /><button type="submit" disabled={!draft.trim()} className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"><MessageCircle className="h-4 w-4" /></button></form><div className="mt-2 flex justify-between px-1 font-mono text-[9px] text-muted-foreground"><span><b>enter</b> send · <b>shift + enter</b> new line</span><span className={connection === "live" ? "text-chart-4" : "text-primary"}>● {connection}</span></div></div>
          </section>
          {showMembers && !activeDm && <aside className="hidden w-[285px] shrink-0 border-l border-border bg-card/70 lg:flex lg:flex-col"><div className="border-b border-border px-4 py-5"><p className="font-mono text-[10px] uppercase tracking-[.16em] text-muted-foreground">in the room</p><p className="mt-1 font-mono text-lg font-bold">{room.members.length} <span className="text-xs font-normal text-muted-foreground">people</span></p></div><div className="flex-1 overflow-y-auto p-3">{room.members.map((member) => <div key={member.id} className="group rounded-md px-2 py-2 hover:bg-muted"><div className="flex items-center gap-2"><Avatar user={member} size="sm" /><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs">{member.displayName} {member.status === "online" ? <span className="ml-1 text-chart-4">●</span> : <span className="ml-1 text-muted-foreground">○</span>}</p><p className="font-mono text-[9px] text-muted-foreground">@{member.username} · {member.role}</p></div><button onClick={() => setActiveDm(member)} className="rounded p-1 text-muted-foreground hover:text-primary" aria-label={`Message ${member.displayName}`}><MessageCircle className="h-3.5 w-3.5" /></button></div>{member.id !== profile.id && <div className="mt-2 hidden gap-1 group-hover:flex"><button onClick={() => blockUser(member)} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-accent hover:text-accent">block</button>{actorRole === "owner" && member.role === "member" && <button onClick={() => moderate(member, "moderator")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-secondary-foreground hover:text-secondary-foreground">mod</button>}{["owner", "moderator"].includes(actorRole ?? "") && member.role === "member" && <><button onClick={() => moderate(member, "mute")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary">mute</button><button onClick={() => moderate(member, "kick")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-primary hover:text-primary">kick</button><button onClick={() => moderate(member, "ban")} className="rounded border border-border px-1.5 py-1 font-mono text-[9px] text-muted-foreground hover:border-destructive hover:text-destructive">ban</button></>}</div>}</div>)}</div></aside>}
        </div>
      </main>

      {panel === "notifications" && <Overlay title="Notifications" onClose={() => setPanel(null)}><div className="space-y-2">{notifications.length === 0 ? <p className="font-mono text-xs text-muted-foreground">You are all caught up.</p> : notifications.map((notice) => <button key={notice.id} onClick={() => markRead(notice)} className={`flex w-full items-start gap-3 rounded-lg p-3 text-left ${notice.readAt ? "bg-muted/30" : "bg-primary/10"}`}><Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span><span className="block font-mono text-xs">{notice.body}</span><span className="mt-1 block font-mono text-[10px] text-muted-foreground">{timeLabel(notice.createdAt)} {notice.readAt ? "· read" : "· new"}</span></span></button>)}</div></Overlay>}
      {panel === "profile" && <Overlay title="Your profile" onClose={() => setPanel(null)}><form onSubmit={saveProfile} className="space-y-4"><div className="flex items-center gap-3"><Avatar user={profile} size="lg" /><div><p className="font-mono text-sm font-bold">{profile.displayName}</p><p className="font-mono text-xs text-muted-foreground">Account profile</p></div></div><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">username</span><input name="username" defaultValue={profile.username} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">display name</span><input name="displayName" defaultValue={profile.displayName} className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><button className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground"><Check className="h-4 w-4" /> save profile</button><button type="button" onClick={() => signOut({ redirectUrl: basePath || "/" })} className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 font-mono text-xs text-muted-foreground hover:bg-muted"><LogOut className="h-4 w-4" /> sign out</button></form></Overlay>}
      {panel === "search" && <Overlay title={`Search results for “${search}”`} onClose={() => setPanel(null)}><div className="space-y-4">{searchResults.length === 0 ? <p className="font-mono text-xs text-muted-foreground">No messages found.</p> : searchResults.map((message) => <div key={message.id} className="border-b border-border pb-3"><div className="flex justify-between font-mono text-[10px] text-muted-foreground"><span className="text-secondary-foreground">{message.sender?.displayName}</span><span>{timeLabel(message.createdAt)}</span></div><p className="mt-1 text-sm">{message.body}</p></div>)}</div></Overlay>}
      {newChannelOpen && <Overlay title="Create a public channel" onClose={() => setNewChannelOpen(false)}><form onSubmit={createChannel} className="space-y-4"><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">channel name</span><input autoFocus value={newChannelName} onChange={(event) => setNewChannelName(event.target.value)} placeholder="#room-name" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">topic</span><input value={newChannelTopic} onChange={(event) => setNewChannelTopic(event.target.value)} placeholder="What is this room about?" className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary" /></label><button className="w-full rounded-md bg-primary py-2.5 font-mono text-xs font-bold text-primary-foreground">create channel</button></form></Overlay>}
    </div>
  );
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-40 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center"><div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="font-mono text-base font-bold">{title}</h2><button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close"><X className="h-4 w-4" /></button></div>{children}</div></div>;
}

function AuthRoutes() {
  return <Switch><Route path="/" component={Landing} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/chat"><Show when="signed-in"><ChatApp /></Show><Show when="signed-out"><Redirect to="/" /></Show></Route><Route component={Landing} /></Switch>;
}

function SignInPage() { return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>; }
function SignUpPage() { return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>; }

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