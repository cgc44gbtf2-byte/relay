import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOrganizationPages,
  mergeOrganizationPages,
  useOrganizationFreshness,
  type OrganizationPage,
} from "./useOrganizationFreshness";

type Page = Omit<OrganizationPage, "invitations"> & {
  community: { id: number; name: string };
  settingsDraft: string;
  invitations: Array<{ id: number; emailDeliveryStatus?: string }>;
};

const page = (id: number, suffix: string): Page => ({
  community: { id, name: `Workspace ${id}` },
  settingsDraft: "unsaved local value",
  invitations: [{ id: 99 }],
  members: [{ id: `member-${suffix}` }],
  employees: [{ userId: "employee-1", departmentId: Number(suffix), locationId: Number(suffix), teamIds: [Number(suffix)] }],
  assignments: [{ id: Number(suffix), userId: "employee-1", role: `role-${suffix}` }],
  departments: [{ id: Number(suffix), managerId: `dept-manager-${suffix}` }],
  locations: [{ id: Number(suffix), name: `location-${suffix}` }],
  teams: [{ id: Number(suffix), managerId: `team-manager-${suffix}` }],
  teamMemberships: [{ teamId: Number(suffix), userId: "employee-1" }],
  pagination: {
    employees: { hasMore: false },
    assignments: { hasMore: false },
    departments: { hasMore: false },
    locations: { hasMore: false },
    teams: { hasMore: false },
  },
});

const onError = vi.fn();

describe("organization freshness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges cross-session relationship changes without replacing settings or unrelated loaded rows", () => {
    const current = page(7, "1");
    current.invitations.push({ id: 100 });
    const fresh = page(7, "2");
    const merged = mergeOrganizationPages(current, [fresh]);

    expect(merged.settingsDraft).toBe("unsaved local value");
    expect(merged.invitations).toEqual([{ id: 99 }]);
    expect(merged.departments[0]).toMatchObject({ managerId: "dept-manager-2" });
    expect(merged.teams[0]).toMatchObject({ managerId: "team-manager-2" });
    expect(merged.employees[0]).toMatchObject({ departmentId: 2, locationId: 2, teamIds: [2] });
  });

  it("refreshes every already-loaded page while keeping requests workspace scoped", async () => {
    const current = page(12, "1");
    current.employees = Array.from({ length: 175 }, (_, index) => ({ userId: `u-${index}` }));
    const request = vi.fn(async (_path: string) => page(12, "2"));

    await fetchOrganizationPages(12, current, request);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([path]) => path.startsWith("/communities/12?"))).toBe(true);
    expect(request.mock.calls[1][0]).toContain("employeesOffset=100");
    expect(request.mock.calls[1][0]).toContain("employeesLimit=75");
  });

  it("keeps the loaded row depth when replacing paginated organization data", () => {
    const current = page(12, "1");
    current.employees = Array.from({ length: 175 }, (_, index) => ({ userId: `old-${index}` }));
    const first = page(12, "2");
    first.employees = Array.from({ length: 100 }, (_, index) => ({ userId: `fresh-${index}` }));
    const second = page(12, "3");
    second.employees = Array.from({ length: 75 }, (_, index) => ({ userId: `fresh-${index + 100}` }));

    const merged = mergeOrganizationPages(current, [first, second]);

    expect(merged.employees).toHaveLength(175);
    expect(merged.employees.at(-1)).toEqual({ userId: "fresh-174" });
    expect(merged.invitations).toEqual(first.invitations);
  });

  it("refreshes delivery outcomes across every loaded invitation page", async () => {
    const current = page(12, "1");
    current.invitations = Array.from({ length: 175 }, (_, id) => ({ id }));
    const first = page(12, "2");
    first.invitations = current.invitations.slice(0, 100);
    const second = page(12, "3");
    second.invitations = current.invitations.slice(100).map((item) => ({ ...item, emailDeliveryStatus: "bounced" }));
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const pages = await fetchOrganizationPages<Page>(12, current, request);
    expect(request.mock.calls[1][0]).toContain("invitationsOffset=100");
    expect(request.mock.calls[1][0]).toContain("invitationsLimit=75");
    const merged = mergeOrganizationPages(current, pages);
    expect(merged.invitations).toHaveLength(175);
    expect(merged.invitations.at(-1)).toMatchObject({ id: 174, emailDeliveryStatus: "bounced" });
    expect(merged.settingsDraft).toBe(current.settingsDraft);
  });

  it("ignores stale workspace responses and does not overlap polls", async () => {
    let resolveFirst!: (value: string) => void;
    const fetchFresh = vi.fn((id: number) => id === 1
      ? new Promise<string>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve("workspace-two"));
    const applyFresh = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useOrganizationFreshness({ workspaceId: id, enabled: true, intervalMs: 30_000, fetchFresh, applyFresh, onError }),
      { initialProps: { id: 1 } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchFresh).toHaveBeenCalledTimes(1);
    rerender({ id: 2 });
    await act(async () => {
      resolveFirst("workspace-one");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(applyFresh).toHaveBeenCalledTimes(1);
    expect(applyFresh).toHaveBeenCalledWith(2, "workspace-two");
  });

  it("pauses while hidden and drops responses after unmount", async () => {
    let resolve!: (value: string) => void;
    const fetchFresh = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const applyFresh = vi.fn();
    const { unmount } = renderHook(() =>
      useOrganizationFreshness({ workspaceId: 4, enabled: true, intervalMs: 30_000, fetchFresh, applyFresh, onError }));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchFresh).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchFresh).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      resolve("late");
      await Promise.resolve();
    });
    expect(applyFresh).not.toHaveBeenCalled();
  });

  it("drops a poll response when a mutation disables freshness", async () => {
    let resolve!: (value: string) => void;
    const fetchFresh = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const applyFresh = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useOrganizationFreshness({ workspaceId: 8, enabled, intervalMs: 30_000, fetchFresh, applyFresh, onError }),
      { initialProps: { enabled: true } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    rerender({ enabled: false });
    await act(async () => {
      resolve("stale-before-mutation");
      await Promise.resolve();
    });

    expect(applyFresh).not.toHaveBeenCalled();
  });

  it("reports refresh failures and retries on the next interval", async () => {
    const error = new Error("offline");
    const fetchFresh = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("fresh");
    const applyFresh = vi.fn();
    renderHook(() => useOrganizationFreshness({ workspaceId: 3, enabled: true, fetchFresh, applyFresh, onError }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(onError).toHaveBeenCalledWith(error);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(applyFresh).toHaveBeenCalledWith(3, "fresh");
  });

  it("discards an in-flight response when visibility changes", async () => {
    let resolve!: (value: string) => void;
    const fetchFresh = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const applyFresh = vi.fn();
    renderHook(() => useOrganizationFreshness({ workspaceId: 3, enabled: true, fetchFresh, applyFresh, onError }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { resolve("stale"); });
    expect(applyFresh).not.toHaveBeenCalled();
  });
});