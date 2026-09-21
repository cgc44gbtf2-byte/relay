import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowUp,
  AtSign,
  ChevronRight,
  Hash,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  Signal,
  Terminal,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type { IrcMessage, IrcState, IrcUser } from '@workspace/api-client-react';
import {
  getGetIrcStateQueryKey,
  getHealthCheckQueryKey,
  getStreamIrcEventsQueryKey,
  useGetIrcState,
  useHealthCheck,
  useJoinIrcChannel,
  useSendIrcMessage,
  useStreamIrcEvents,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Router as WouterRouter, Switch, useLocation } from 'wouter';

const queryClient = new QueryClient();
const defaultChannels = ['#lobby', '#design', '#help', '#music'];
const fallbackTopic = 'the room is open — say something worth remembering';

function normalizeChannel(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function initials(nick: string) {
  return nick.slice(0, 2).toUpperCase();
}

function MessageRow({ message }: { message: IrcMessage }) {
  const isSystem = message.kind === 'system';

  if (isSystem) {
    return (
      <div className="message-in flex items-center gap-3 py-2.5 pl-3 text-xs font-mono text-muted-foreground" data-testid={`message-system-${message.id}`}>
        <span className="h-px w-5 bg-accent/60" />
        <span>{message.text}</span>
      </div>
    );
  }

  return (
    <article className="message-in group grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 px-3 py-2 hover:bg-foreground/[0.025]" data-testid={`message-row-${message.id}`}>
      <div
        className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-[10px] font-bold tracking-tight text-background"
        style={{ backgroundColor: message.nick === 'bytebloom' ? 'hsl(var(--primary))' : 'hsl(var(--secondary-foreground))' }}
        title={message.nick}
      >
        {initials(message.nick)}
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span
            className="font-mono text-[12px] font-bold"
            style={{ color: message.nick === 'bytebloom' ? 'hsl(var(--primary))' : 'hsl(var(--secondary-foreground))' }}
            data-testid={`text-message-nick-${message.id}`}
          >
            {message.nick}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/65">{formatTime(message.timestamp)}</span>
        </div>
        <p className="break-words text-[13px] leading-5 text-foreground/90" data-testid={`text-message-content-${message.id}`}>
          {message.text}
        </p>
      </div>
      <button
        className="mt-1 hidden h-6 w-6 items-center justify-center rounded text-muted-foreground/50 hover:bg-muted hover:text-foreground group-hover:flex"
        onClick={() => navigator.clipboard?.writeText(message.text)}
        title="Copy message"
        aria-label={`Copy message from ${message.nick}`}
        data-testid={`button-copy-message-${message.id}`}
      >
        <ArrowUp className="h-3.5 w-3.5 rotate-45" />
      </button>
    </article>
  );
}

function MessageSkeleton() {
  return (
    <div className="space-y-4 px-3 py-4" data-testid="loading-messages">
      {[1, 2, 3, 4, 5].map((item) => (
        <div className="flex gap-3" key={item}>
          <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-2.5 w-24 animate-pulse rounded bg-muted" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ChannelRail({
  currentChannel,
  onChannelChange,
  onJoin,
  mobile = false,
  onClose,
}: {
  currentChannel: string;
  onChannelChange: (channel: string) => void;
  onJoin: () => void;
  mobile?: boolean;
  onClose?: () => void;
}) {
  const [filter, setFilter] = useState('');
  const channels = useMemo(
    () => defaultChannels.filter((channel) => channel.toLowerCase().includes(filter.toLowerCase())),
    [filter],
  );

  return (
    <aside className={`${mobile ? 'fixed inset-y-0 left-0 z-30 w-[286px] shadow-2xl' : 'hidden md:flex md:w-[232px]'} flex-col border-r border-sidebar-border bg-sidebar`} data-testid="panel-channels">
      <div className="flex h-[72px] items-center justify-between border-b border-sidebar-border px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Terminal className="h-[17px] w-[17px]" />
          </div>
          <div>
            <p className="font-mono text-sm font-bold tracking-tight text-sidebar-foreground">relay</p>
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">irc / local</p>
          </div>
        </div>
        {mobile && (
          <button className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" onClick={onClose} aria-label="Close channels" data-testid="button-close-channels">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="border-b border-sidebar-border p-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-9 w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 pl-9 pr-3 font-mono text-[11px] text-sidebar-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/70"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="find a room"
            aria-label="Filter channels"
            data-testid="input-filter-channels"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-4 scrollbar-thin">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">rooms</span>
          <button
            className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-primary"
            onClick={onJoin}
            title="Join a room"
            aria-label="Join a room"
            data-testid="button-open-join"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <nav className="space-y-1" aria-label="Channels">
          {channels.map((channel) => {
            const active = channel === currentChannel;
            return (
              <button
                key={channel}
                onClick={() => onChannelChange(channel)}
                className={`group flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left font-mono text-[12px] transition-colors ${active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'}`}
                data-testid={`button-channel-${channel.slice(1)}`}
              >
                <span className="flex items-center gap-2">
                  <Hash className={`h-3.5 w-3.5 ${active ? 'text-primary' : 'text-muted-foreground/70'}`} />
                  {channel.slice(1)}
                </span>
                {active && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </button>
            );
          })}
          {channels.length === 0 && <p className="px-2.5 py-3 font-mono text-[11px] text-muted-foreground">no rooms found</p>}
        </nav>
      </div>

      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2 rounded-md bg-sidebar-accent/50 px-2.5 py-2">
          <span className="relative flex h-2 w-2">
            <span className="presence-pulse absolute inline-flex h-full w-full rounded-full bg-chart-4" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-chart-4" />
          </span>
          <span className="font-mono text-[10px] text-sidebar-foreground">connected as <b className="text-primary">bytebloom</b></span>
        </div>
      </div>
    </aside>
  );
}

function UserRail({
  users,
  mobile = false,
  onClose,
  healthLabel,
}: {
  users: IrcUser[];
  mobile?: boolean;
  onClose?: () => void;
  healthLabel: string;
}) {
  const onlineUsers = users.filter((user) => user.status === 'online');
  const awayUsers = users.filter((user) => user.status === 'away');
  return (
    <aside className={`${mobile ? 'fixed inset-y-0 right-0 z-30 w-[286px] shadow-2xl' : 'hidden lg:flex lg:w-[252px]'} flex-col border-l border-border bg-card`} data-testid="panel-users">
      <div className="flex h-[72px] items-center justify-between border-b border-border px-4">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">in the room</p>
          <p className="mt-1 font-mono text-lg font-bold text-foreground" data-testid="text-user-count">{users.length} <span className="text-xs font-normal text-muted-foreground">voices</span></p>
        </div>
        {mobile && (
          <button className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose} aria-label="Close users" data-testid="button-close-users">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4 scrollbar-thin">
        <div className="mb-2 px-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">online — {onlineUsers.length}</div>
        <div className="space-y-0.5">
          {onlineUsers.map((user) => <UserRow key={user.nick} user={user} />)}
          {onlineUsers.length === 0 && <p className="px-2 py-2 font-mono text-[11px] text-muted-foreground">no one is visible yet</p>}
        </div>
        {awayUsers.length > 0 && (
          <>
            <div className="mb-2 mt-7 px-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">away — {awayUsers.length}</div>
            <div className="space-y-0.5">{awayUsers.map((user) => <UserRow key={user.nick} user={user} />)}</div>
          </>
        )}
      </div>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2 px-1 font-mono text-[10px] text-muted-foreground">
          <Signal className={`h-3.5 w-3.5 ${healthLabel === 'online' ? 'text-chart-4' : 'text-primary'}`} />
          <span data-testid="status-server-health">relay server {healthLabel}</span>
        </div>
      </div>
    </aside>
  );
}

function UserRow({ user }: { user: IrcUser }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-2 hover:bg-muted/60" data-testid={`row-user-${user.nick}`}>
      <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-bold text-background" style={{ backgroundColor: user.color }}>
        {initials(user.nick)}
        <span className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${user.status === 'away' ? 'bg-primary' : 'bg-chart-4'}`} />
      </div>
      <span className={`truncate font-mono text-[12px] ${user.status === 'away' ? 'text-muted-foreground' : 'text-foreground/90'}`}>{user.nick}</span>
      {user.nick === 'bytebloom' && <span className="ml-auto font-mono text-[9px] uppercase tracking-wide text-primary">you</span>}
    </div>
  );
}

function JoinDialog({
  onClose,
  onJoined,
  currentNick,
}: {
  onClose: () => void;
  onJoined: (state: IrcState) => void;
  currentNick: string;
}) {
  const [channel, setChannel] = useState('');
  const [nick, setNick] = useState(currentNick);
  const join = useJoinIrcChannel();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeChannel(channel);
    if (!normalized || !nick.trim()) return;
    join.mutate({ data: { channel: normalized, nick: nick.trim() } }, { onSuccess: onJoined });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-labelledby="join-title" data-testid="dialog-join">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">open a connection</p>
            <h2 id="join-title" className="mt-1 font-mono text-lg font-bold text-foreground">Join a room</h2>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close join dialog" data-testid="button-close-join">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">channel</span>
            <div className="relative">
              <Hash className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary" />
              <input autoFocus value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="room-name" className="h-11 w-full rounded-md border border-input bg-background pl-9 pr-3 font-mono text-sm outline-none focus:border-primary" data-testid="input-join-channel" />
            </div>
          </label>
          <label className="block">
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">your nick</span>
            <div className="relative">
              <AtSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary-foreground" />
              <input value={nick} maxLength={24} onChange={(event) => setNick(event.target.value)} className="h-11 w-full rounded-md border border-input bg-background pl-9 pr-3 font-mono text-sm outline-none focus:border-primary" data-testid="input-join-nick" />
            </div>
          </label>
          {join.isError && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive" data-testid="error-join">{getErrorMessage(join.error)}</p>}
          <button disabled={join.isPending} type="submit" className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary font-mono text-xs font-bold text-primary-foreground transition-transform hover:brightness-105 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60" data-testid="button-submit-join">
            {join.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {join.isPending ? 'connecting…' : 'join room'}
          </button>
        </form>
      </div>
    </div>
  );
}

function getErrorMessage(error: unknown) {
  if (typeof error === 'object' && error !== null && 'error' in error) return String((error as { error: string }).error);
  return 'the relay could not complete that request';
}

function Workspace() {
  const [currentChannel, setCurrentChannel] = useState('#lobby');
  const [nick] = useState('bytebloom');
  const [draft, setDraft] = useState('');
  const [joinOpen, setJoinOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'channels' | 'users' | null>(null);
  const [liveMessages, setLiveMessages] = useState<IrcMessage[]>([]);
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [streamError, setStreamError] = useState('');
  const endOfMessagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  const stateQuery = useGetIrcState(
    { channel: currentChannel },
    { query: { queryKey: getGetIrcStateQueryKey({ channel: currentChannel }), staleTime: 10_000, retry: 1 } },
  );
  const healthQuery = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), staleTime: 30_000, retry: 0 } });
  useStreamIrcEvents(
    { channel: currentChannel },
    { query: { enabled: false, queryKey: getStreamIrcEventsQueryKey({ channel: currentChannel }) } },
  );
  const send = useSendIrcMessage();

  const state = stateQuery.data;
  const messages = useMemo(() => {
    const fromApi = state?.messages ?? [];
    const all = [...fromApi, ...liveMessages];
    return all.filter((message, index, list) => list.findIndex((item) => item.id === message.id) === index);
  }, [state?.messages, liveMessages]);
  const channelUsers = state?.users ?? [];
  const topic = state?.topic || fallbackTopic;
  const healthLabel = healthQuery.isSuccess ? (healthQuery.data?.status || 'online') : healthQuery.isError ? 'offline' : 'checking';

  useEffect(() => {
    setLiveMessages([]);
    setStreamError('');
    setStreamState('connecting');
  }, [currentChannel]);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setStreamState((previous) => previous === 'live' ? 'reconnecting' : 'connecting');
      source = new EventSource(`/api/irc/events?channel=${encodeURIComponent(currentChannel)}`);
      source.onopen = () => {
        setStreamState('live');
        setStreamError('');
      };
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as IrcMessage | IrcState;
          if ('messages' in payload && Array.isArray(payload.messages)) {
            queryClient.setQueryData(getGetIrcStateQueryKey({ channel: currentChannel }), payload);
          } else if ('id' in payload && payload.channel === currentChannel) {
            setLiveMessages((previous) => [...previous, payload]);
          }
        } catch {
          setStreamError('received an unreadable event');
        }
      };
      source.onerror = () => {
        source?.close();
        if (!disposed) {
          setStreamState('reconnecting');
          setStreamError('live link interrupted — trying again');
          reconnectTimer = window.setTimeout(connect, 3500);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
  }, [currentChannel, queryClient]);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft('');
    send.mutate(
      { data: { channel: currentChannel, nick, text } },
      {
        onSuccess: (message) => setLiveMessages((previous) => [...previous, message]),
        onError: () => setDraft(text),
      },
    );
  };

  const handleJoined = (joinedState: IrcState) => {
    setJoinOpen(false);
    setCurrentChannel(joinedState.channel);
    queryClient.setQueryData(getGetIrcStateQueryKey({ channel: joinedState.channel }), joinedState);
  };

  const retryState = () => stateQuery.refetch();

  return (
    <div className="irc-grid terminal-sheen scanline flex min-h-[100dvh] overflow-hidden bg-background text-foreground">
      {mobilePanel === 'channels' && <ChannelRail currentChannel={currentChannel} onChannelChange={(channel) => { setCurrentChannel(channel); setMobilePanel(null); }} onJoin={() => setJoinOpen(true)} mobile onClose={() => setMobilePanel(null)} />}
      {mobilePanel === 'users' && <UserRail users={channelUsers} mobile onClose={() => setMobilePanel(null)} healthLabel={healthLabel} />}

      <ChannelRail currentChannel={currentChannel} onChannelChange={setCurrentChannel} onJoin={() => setJoinOpen(true)} />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[72px] items-center justify-between border-b border-border bg-card/80 px-3 backdrop-blur-sm sm:px-5">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden" onClick={() => setMobilePanel('channels')} aria-label="Open channels" data-testid="button-mobile-channels">
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Hash className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate font-mono text-sm font-bold text-foreground sm:text-base" data-testid="text-current-channel">{currentChannel}</h1>
                <span className="hidden rounded bg-chart-4/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-chart-4 sm:inline">open</span>
              </div>
              <p className="mt-0.5 max-w-[42vw] truncate text-[11px] text-muted-foreground" data-testid="text-channel-topic">{topic}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-3">
            <div className="hidden items-center gap-1.5 font-mono text-[10px] text-muted-foreground sm:flex">
              <span className={`h-1.5 w-1.5 rounded-full ${streamState === 'live' ? 'bg-chart-4' : 'bg-primary'}`} />
              <span data-testid="status-stream">{streamState === 'live' ? 'live' : streamState}</span>
            </div>
            <button className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden" onClick={() => setMobilePanel('users')} aria-label="Open users" data-testid="button-mobile-users">
              <Users className="h-4 w-4" />
            </button>
            <button className="hidden rounded-md border border-border px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground sm:flex sm:items-center sm:gap-1.5" onClick={() => setJoinOpen(true)} data-testid="button-header-join">
              <Plus className="h-3.5 w-3.5" /> join
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {stateQuery.isLoading ? <MessageSkeleton /> : stateQuery.isError ? (
              <div className="flex min-h-[300px] flex-col items-center justify-center px-6 text-center" data-testid="state-error">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-5 w-5" /></div>
                <h2 className="font-mono text-sm font-bold">could not load {currentChannel}</h2>
                <p className="mt-1 max-w-sm font-mono text-[11px] leading-5 text-muted-foreground">{getErrorMessage(stateQuery.error)}</p>
                <button onClick={retryState} className="mt-5 flex items-center gap-2 rounded-md border border-border px-3 py-2 font-mono text-[11px] text-foreground hover:bg-muted" data-testid="button-retry-state"><RefreshCw className="h-3.5 w-3.5" /> retry room</button>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex min-h-[300px] flex-col items-center justify-center px-6 text-center" data-testid="empty-messages">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary"><MessageSquare className="h-5 w-5" /></div>
                <h2 className="font-mono text-sm font-bold">the room is quiet</h2>
                <p className="mt-1 max-w-xs font-mono text-[11px] leading-5 text-muted-foreground">Be the first voice in {currentChannel}. Your message will wake the room.</p>
              </div>
            ) : (
              <div className="py-4">
                <div className="mb-4 flex items-center gap-3 px-4">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">recent history</span>
                  <span className="h-px flex-1 bg-border/70" />
                  <span className="font-mono text-[10px] text-muted-foreground">{messages.length} lines</span>
                </div>
                {messages.map((message) => <MessageRow key={message.id} message={message} />)}
                <div ref={endOfMessagesRef} />
              </div>
            )}
          </div>

          <div className="border-t border-border bg-card/70 px-3 pb-3 pt-2.5 sm:px-5 sm:pb-5">
            {streamError && <div className="mb-2 flex items-center gap-2 font-mono text-[10px] text-primary" data-testid="status-stream-error"><RefreshCw className="h-3 w-3" /> {streamError}</div>}
            {send.isError && <div className="mb-2 flex items-center gap-2 font-mono text-[10px] text-destructive" data-testid="error-send"><AlertCircle className="h-3 w-3" /> {getErrorMessage(send.error)}</div>}
            <form onSubmit={sendMessage} className="relative flex items-end gap-2 rounded-lg border border-input bg-background p-2 transition-colors focus-within:border-primary/70" data-testid="form-send-message">
              <textarea
                ref={inputRef}
                rows={1}
                maxLength={500}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={`message ${currentChannel}`}
                className="max-h-28 min-h-[26px] flex-1 resize-none bg-transparent px-2 py-1 font-mono text-[12px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/60"
                aria-label={`Message ${currentChannel}`}
                data-testid="input-message"
              />
              <div className="flex items-center gap-2 pb-0.5">
                <span className="hidden font-mono text-[9px] text-muted-foreground/60 sm:inline">{draft.length}/500</span>
                <button type="submit" disabled={!draft.trim() || send.isPending} className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-transform hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35" aria-label="Send message" data-testid="button-send-message">
                  {send.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </button>
              </div>
            </form>
            <div className="mt-2 flex items-center justify-between px-1 font-mono text-[9px] text-muted-foreground/55">
              <span><b className="text-muted-foreground">enter</b> to send <span className="mx-1">·</span> <b className="text-muted-foreground">shift + enter</b> for a new line</span>
              <span className="hidden items-center gap-1 sm:flex"><ChevronRight className="h-3 w-3" /> {nick}</span>
            </div>
          </div>
        </div>
      </main>

      <UserRail users={channelUsers} healthLabel={healthLabel} />
      {joinOpen && <JoinDialog onClose={() => setJoinOpen(false)} onJoined={handleJoined} currentNick={nick} />}
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Workspace} />
      <Route component={NotFound} />
    </Switch>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <RoutedErrorBoundary><Router /></RoutedErrorBoundary>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;