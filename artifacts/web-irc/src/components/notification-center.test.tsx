import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter, type Notification } from "./notification-center";

const notice = (id: number, body: string): Notification => ({
  id,
  type: "direct_message",
  category: "direct_message",
  body,
  entityType: "message",
  entityId: `message-${id}`,
  createdAt: "2026-09-21T12:00:00.000Z",
  readAt: null,
});

function setup(initial = [notice(1, "You have a new direct message."), notice(2, "Another notice")]) {
  let saved = initial.map((item) => ({ ...item }));
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const id = Number(path.match(/\/notifications\/(\d+)/)?.[1]);
    if (path === "/notifications?archived=true&limit=100&offset=0") return saved.filter((item) => item.archivedAt);
    if (path.endsWith("/detail")) return {
      notification: saved.find((item) => item.id === id),
      message: { id: `message-${id}`, body: "The complete private message, not a preview.", channelId: null, sender: { id: "sender", username: "sender", displayName: "Sender" } },
    };
    if (path.endsWith("/read")) {
      saved = saved.map((item) => item.id === id ? { ...item, readAt: new Date().toISOString() } : item);
    }
    if (path.endsWith("/archive")) {
      saved = saved.map((item) => item.id === id ? { ...item, archivedAt: new Date().toISOString() } : item);
    }
    if (path.endsWith("/restore")) {
      saved = saved.map((item) => item.id === id ? { ...item, archivedAt: null } : item);
    }
    if (path === "/notifications/read-all") {
      saved = saved.map((item) => ({ ...item, readAt: new Date().toISOString() }));
    }
    if (path === "/notifications/clear") saved = saved.filter((item) => item.archivedAt);
    if (init?.method === "DELETE" && id) saved = saved.filter((item) => item.id !== id);
    return { ok: true };
  });
  const onOpenMessage = vi.fn();
  function Fixture() {
    const [items, setItems] = useState(initial);
    return <NotificationCenter notifications={items} setNotifications={setItems} request={<T,>(path: string, init?: RequestInit) => request(path, init) as Promise<T>} revision={0} onClose={vi.fn()} onNavigate={vi.fn()} onOpenMessage={onOpenMessage} />;
  }
  render(<Fixture />);
  return { request, onOpenMessage };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("notification center", () => {
  it("opens a full message in a detail pop-up instead of navigating immediately", async () => {
    const { onOpenMessage } = setup();
    fireEvent.click(screen.getByTestId("button-notification-1"));
    await waitFor(() => expect(screen.getByTestId("text-notification-full-content").textContent).toBe("The complete private message, not a preview."));
    expect(onOpenMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-open-notification-message"));
    expect(onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "message-1" }));
  });

  it("marks all as read, clears the inbox, and leaves archived notifications available", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { request } = setup();
    fireEvent.click(screen.getByTestId("button-archive-notification-2"));
    await waitFor(() => expect(screen.queryByTestId("button-notification-2")).toBeNull());
    fireEvent.click(screen.getByTestId("button-mark-all-read"));
    await waitFor(() => expect(screen.getByTestId("button-mark-all-read").hasAttribute("disabled")).toBe(true));
    fireEvent.click(screen.getByTestId("button-clear-all-notifications"));
    await waitFor(() => expect(screen.getByText("You are all caught up.")).toBeTruthy());
    fireEvent.click(screen.getByTestId("button-notifications-archived"));
    await waitFor(() => expect(screen.getByTestId("button-notification-2")).toBeTruthy());
    expect(request).toHaveBeenCalledWith("/notifications/read-all", { method: "POST" });
    expect(request).toHaveBeenCalledWith("/notifications/clear", { method: "DELETE" });
  });

  it("restores and deletes individual notifications", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { request } = setup();
    fireEvent.click(screen.getByTestId("button-archive-notification-1"));
    await waitFor(() => expect(screen.queryByTestId("button-notification-1")).toBeNull());
    fireEvent.click(screen.getByTestId("button-notifications-archived"));
    await waitFor(() => expect(screen.getByTestId("button-restore-notification-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("button-restore-notification-1"));
    await waitFor(() => expect(screen.queryByTestId("button-notification-1")).toBeNull());
    fireEvent.click(screen.getByTestId("button-notifications-inbox"));
    fireEvent.click(screen.getByTestId("button-delete-notification-1"));
    await waitFor(() => expect(screen.queryByTestId("button-notification-1")).toBeNull());
    expect(request).toHaveBeenCalledWith("/notifications/1/restore", { method: "POST" });
    expect(request).toHaveBeenCalledWith("/notifications/1", { method: "DELETE" });
  });
});