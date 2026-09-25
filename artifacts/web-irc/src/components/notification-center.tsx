import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Archive, ArrowLeft, Bell, CheckCheck, RotateCcw, Trash2 } from "lucide-react";
import { useDialogFocus } from "../use-dialog-focus";

export type Notification = {
  id: number;
  type: string;
  category: "direct_message" | "mention" | "task_assigned" | "task_updated" | "task_deadline" | "announcement" | "document_acknowledgement" | "join_request" | "report" | "administrative_action" | "general";
  body: string;
  communityId?: number | null;
  entityType?: string | null;
  entityId?: string | null;
  actionUrl?: string | null;
  readAt?: string | null;
  archivedAt?: string | null;
  createdAt: string;
};

export type LinkedNotificationMessage = {
  id: string;
  body: string;
  channelId?: number | null;
  sender: { id: string; username: string; displayName: string } | null;
  deletedAt?: string | null;
};

const labels: Record<Notification["category"], string> = {
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

type Props = {
  notifications: Notification[];
  setNotifications: Dispatch<SetStateAction<Notification[]>>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  /**
   * Page-aware requests are supplied by the app so pagination can consume
   * response headers without loading every page up front.
   */
  requestPage?: <T>(path: string) => Promise<{ data: T[]; hasMore: boolean; nextOffset: number | null }>;
  onClose: () => void;
  onNavigate: (url: string) => void;
  onOpenMessage: (message: LinkedNotificationMessage) => void;
  revision: number;
};

export function NotificationCenter({ notifications, setNotifications, request, requestPage, onClose, onNavigate, onOpenMessage, revision }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  useDialogFocus(dialogRef, close);
  const [view, setView] = useState<"inbox" | "archived">("inbox");
  const [archived, setArchived] = useState<Notification[]>([]);
  const [selected, setSelected] = useState<Notification | null>(null);
  const [linkedMessage, setLinkedMessage] = useState<LinkedNotificationMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState({ inbox: false, archived: false });
  const [nextOffset, setNextOffset] = useState({ inbox: 0, archived: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [archivedReload, setArchivedReload] = useState(0);
  const [filter, setFilter] = useState<"all" | Notification["category"]>("all");
  const detailRequestId = useRef(0);
  const items = view === "inbox" ? notifications : archived;
  const visible = filter === "all" ? items : items.filter((item) => item.category === filter);
  const unreadCount = notifications.filter((item) => !item.readAt).length;
  useEffect(() => {
    if (selected) dialogRef.current?.querySelector<HTMLElement>('[data-testid="button-back-notifications"]')?.focus();
    else if (document.activeElement === document.body) dialogRef.current?.querySelector<HTMLElement>('[data-testid="button-notifications-inbox"]')?.focus();
  }, [selected?.id]);

  // Bootstrap data arrives after this component may mount. Until the app
  // supplies page metadata, a full page is the only safe indication that
  // another page may exist.
  useEffect(() => {
    if (nextOffset.inbox !== 0 || notifications.length === 0) return;
    setHasMore((current) => ({ ...current, inbox: notifications.length >= 100 }));
    setNextOffset((current) => ({ ...current, inbox: notifications.length }));
  }, [notifications.length, nextOffset.inbox]);

  useEffect(() => {
    if (view !== "archived") return;
    let active = true;
    setLoading(true);
    setError("");
    const path = "/notifications?archived=true&limit=100&offset=0";
    const pageRequest = requestPage
      ? requestPage<Notification>(path).then(({ data, hasMore: more, nextOffset: next }) => ({ rows: data, more, next }))
      : request<Notification[]>(path).then((rows) => ({ rows, more: rows.length >= 100, next: rows.length }));
    void pageRequest
      .then(({ rows, more, next }) => {
        if (!active) return;
        setArchived(rows);
        setHasMore((current) => ({ ...current, archived: more }));
        setNextOffset((current) => ({ ...current, archived: next ?? rows.length }));
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load archived notifications."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [view, request, requestPage, revision, archivedReload]);

  const loadOlder = async () => {
    if (loadingMore || !hasMore[view]) return;
    setLoadingMore(true);
    setError("");
    const offset = nextOffset[view];
    const path = `/notifications${view === "archived" ? "?archived=true" : "?"}limit=100&offset=${offset}`;
    try {
      const result = requestPage
        ? await requestPage<Notification>(path)
        : { data: await request<Notification[]>(path), hasMore: false, nextOffset: null };
      const rows = result.data;
      const merge = (current: Notification[]) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        rows.forEach((item) => byId.set(item.id, item));
        return [...byId.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id);
      };
      if (view === "archived") setArchived(merge);
      else setNotifications(merge);
      setHasMore((current) => ({ ...current, [view]: result.hasMore }));
      setNextOffset((current) => ({ ...current, [view]: result.nextOffset ?? offset + rows.length }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load older notifications.");
    } finally {
      setLoadingMore(false);
    }
  };

  const open = async (notice: Notification) => {
    const requestId = ++detailRequestId.current;
    setSelected(notice);
    setLinkedMessage(null);
    setError("");
    setLoading(true);
    void request<{ notification: Notification; message: LinkedNotificationMessage | null }>(`/notifications/${notice.id}/detail`)
      .then(({ notification, message }) => {
        if (detailRequestId.current !== requestId) return;
        setSelected((current) => current?.id === notice.id ? notification : current);
        setLinkedMessage(message);
      })
      .catch((reason) => { if (detailRequestId.current === requestId) setError(reason instanceof Error ? reason.message : "Could not load notification details."); })
      .finally(() => { if (detailRequestId.current === requestId) setLoading(false); });
    if (!notice.readAt) {
      try {
        await request(`/notifications/${notice.id}/read`, { method: "POST" });
        const readAt = new Date().toISOString();
        setNotifications((list) => list.map((item) => item.id === notice.id ? { ...item, readAt } : item));
        setArchived((list) => list.map((item) => item.id === notice.id ? { ...item, readAt } : item));
        setSelected((current) => current?.id === notice.id ? { ...current, readAt } : current);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not mark notification as read.");
      }
    }
  };

  const perform = async (path: string, method: "POST" | "DELETE", onSuccess: () => void) => {
    setBusy(true);
    setError("");
    try {
      await request(path, { method });
      onSuccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update notifications.");
    } finally {
      setBusy(false);
    }
  };

  const archive = (notice: Notification) => void perform(`/notifications/${notice.id}/archive`, "POST", () => {
    setNotifications((list) => list.filter((item) => item.id !== notice.id));
    detailRequestId.current += 1;
    setSelected(null);
  });
  const restore = (notice: Notification) => void perform(`/notifications/${notice.id}/restore`, "POST", () => {
    setArchived((list) => list.filter((item) => item.id !== notice.id));
    setNotifications((list) => [notice, ...list].sort((a, b) => b.id - a.id).slice(0, 100));
    detailRequestId.current += 1;
    setSelected(null);
  });
  const remove = (notice: Notification) => {
    if (!window.confirm("Delete this notification? This cannot be undone.")) return;
    void perform(`/notifications/${notice.id}`, "DELETE", () => {
      setArchived((list) => list.filter((item) => item.id !== notice.id));
      setNotifications((list) => list.filter((item) => item.id !== notice.id));
      detailRequestId.current += 1;
      setSelected(null);
    });
  };

  return <div className="fixed inset-0 z-40 flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center" role="presentation">
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="notification-dialog-title" tabIndex={-1} className="flex max-h-[min(85vh,720px)] w-full max-w-lg flex-col rounded-xl border border-border bg-card shadow-2xl">
      <header className="flex items-center justify-between gap-3 border-b border-border p-5">
        <div className="flex items-center gap-2">
          {selected && <button type="button" onClick={() => { detailRequestId.current += 1; setSelected(null); setError(""); }} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Back to notifications" data-testid="button-back-notifications"><ArrowLeft className="h-4 w-4" /></button>}
           <h2 id="notification-dialog-title" className="font-mono text-base font-bold">{selected ? labels[selected.category] : "Notifications"}</h2>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close notifications" data-testid="button-close-notifications">×</button>
      </header>
      <div className="min-h-0 overflow-y-auto p-5">
         {error && <div role="alert" className="mb-3 flex items-center gap-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"><span>{error}</span>{selected ? <button type="button" onClick={() => void open(selected)} className="ml-auto underline">retry details</button> : view === "archived" ? <button type="button" onClick={() => setArchivedReload((value) => value + 1)} className="ml-auto underline">retry archived</button> : null}</div>}
        {selected ? <>
          <p className="font-mono text-[10px] text-muted-foreground">{new Date(selected.createdAt).toLocaleString()} · {selected.readAt ? "read" : "new"}</p>
           {loading && <p role="status" className="mt-4 text-xs text-muted-foreground">Loading full details…</p>}
          {linkedMessage ? <div className="mt-4 rounded-lg border border-border bg-background/60 p-4">
            <p className="mb-2 font-mono text-[11px] font-bold text-primary">{linkedMessage.sender?.displayName ?? "Message"}</p>
            <p className="whitespace-pre-wrap break-words text-sm leading-6" data-testid="text-notification-full-content">{linkedMessage.deletedAt ? "This message was deleted." : linkedMessage.body}</p>
          </div> : <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6" data-testid="text-notification-full-content">{selected.body}</p>}
          <div className="mt-6 flex flex-wrap gap-2">
            {linkedMessage && !linkedMessage.deletedAt && <button type="button" onClick={() => onOpenMessage(linkedMessage)} className="rounded-md bg-primary px-3 py-2 font-mono text-xs text-primary-foreground" data-testid="button-open-notification-message">Open {linkedMessage.channelId ? "room" : "conversation"}</button>}
            {selected.actionUrl?.startsWith("/") && !selected.actionUrl.startsWith("//") && <button type="button" onClick={() => onNavigate(selected.actionUrl!)} className="rounded-md border border-primary/50 px-3 py-2 font-mono text-xs text-primary" data-testid="button-open-notification-context">{selected.entityType === "workspace_task" ? "Open task" : "Open related page"}</button>}
            {view === "inbox" ? <button type="button" disabled={busy} onClick={() => archive(selected)} className="flex items-center gap-1 rounded-md border border-border px-3 py-2 font-mono text-xs disabled:opacity-50" data-testid="button-archive-notification"><Archive className="h-3.5 w-3.5" /> Archive</button> : <button type="button" disabled={busy} onClick={() => restore(selected)} className="flex items-center gap-1 rounded-md border border-border px-3 py-2 font-mono text-xs disabled:opacity-50" data-testid="button-restore-notification"><RotateCcw className="h-3.5 w-3.5" /> Restore</button>}
            <button type="button" disabled={busy} onClick={() => remove(selected)} className="flex items-center gap-1 rounded-md border border-destructive/40 px-3 py-2 font-mono text-xs text-destructive disabled:opacity-50" data-testid="button-delete-notification"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
          </div>
        </> : <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
             <button type="button" onClick={() => setView("inbox")} aria-pressed={view === "inbox"} className={`rounded px-3 py-1.5 font-mono text-xs ${view === "inbox" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`} data-testid="button-notifications-inbox">Inbox</button>
             <button type="button" onClick={() => setView("archived")} aria-pressed={view === "archived"} className={`rounded px-3 py-1.5 font-mono text-xs ${view === "archived" ? "bg-primary/15 text-primary" : "text-muted-foreground"}`} data-testid="button-notifications-archived">Archived</button>
            {view === "inbox" && <div className="ml-auto flex gap-2">
              <button type="button" disabled={busy || unreadCount === 0} onClick={() => void perform("/notifications/read-all", "POST", () => setNotifications((list) => list.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }))))} className="flex items-center gap-1 font-mono text-[10px] text-primary disabled:opacity-40" data-testid="button-mark-all-read"><CheckCheck className="h-3.5 w-3.5" />Mark all read</button>
              <button type="button" disabled={busy || notifications.length === 0} onClick={() => { if (window.confirm("Clear all inbox notifications? Archived notifications will remain.")) void perform("/notifications/clear", "DELETE", () => setNotifications([])); }} className="font-mono text-[10px] text-destructive disabled:opacity-40" data-testid="button-clear-all-notifications">Clear all</button>
            </div>}
          </div>
           <div className="mb-4 flex gap-1 overflow-x-auto pb-1">{(["all", ...Object.keys(labels)] as Array<"all" | Notification["category"]>).map((category) => <button type="button" key={category} aria-pressed={filter === category} onClick={() => setFilter(category)} className={`shrink-0 rounded border px-2 py-1 font-mono text-[9px] ${filter === category ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`} data-testid={`button-notification-filter-${category}`}>{category === "all" ? "All" : labels[category]}</button>)}</div>
           {loading ? <p className="text-xs text-muted-foreground">Loading notifications…</p> : visible.length === 0 ? <p className="font-mono text-xs text-muted-foreground">{view === "archived" ? "No archived notifications." : "You are all caught up."}</p> : <div className="space-y-2">{visible.map((notice) => <div key={notice.id} className={`flex items-start gap-1 rounded-lg ${notice.readAt ? "bg-muted/30" : "bg-primary/10"}`}>
            <button type="button" onClick={() => void open(notice)} className="flex min-w-0 flex-1 items-start gap-3 p-3 text-left" data-testid={`button-notification-${notice.id}`}><Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span className="min-w-0"><span className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-primary">{labels[notice.category]}</span><span className="block line-clamp-2 break-words font-mono text-xs">{notice.body}</span><span className="mt-1 block font-mono text-[10px] text-muted-foreground">{new Date(notice.createdAt).toLocaleString()} · {notice.readAt ? "read" : "new"}</span></span></button>
            <button type="button" disabled={busy} onClick={() => view === "inbox" ? archive(notice) : restore(notice)} className="mt-2 rounded p-2 text-muted-foreground hover:text-primary disabled:opacity-40" aria-label={`${view === "inbox" ? "Archive" : "Restore"} notification ${notice.id}`} data-testid={`button-${view === "inbox" ? "archive" : "restore"}-notification-${notice.id}`}>{view === "inbox" ? <Archive className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}</button>
            <button type="button" disabled={busy} onClick={() => remove(notice)} className="mr-1 mt-2 rounded p-2 text-muted-foreground hover:text-destructive disabled:opacity-40" aria-label={`Delete notification ${notice.id}`} data-testid={`button-delete-notification-${notice.id}`}><Trash2 className="h-4 w-4" /></button>
           </div>)}</div>}
           {!selected && hasMore[view] && <button type="button" disabled={loadingMore} onClick={() => void loadOlder()} className="mt-4 w-full rounded border border-border px-3 py-2 font-mono text-xs text-muted-foreground hover:text-primary disabled:opacity-50" data-testid="button-load-older-notifications">{loadingMore ? "Loading older notifications…" : "Load older notifications"}</button>}
        </>}
      </div>
    </section>
  </div>;
}