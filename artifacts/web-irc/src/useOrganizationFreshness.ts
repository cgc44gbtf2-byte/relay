import { useEffect, useRef } from "react";

const PAGE_SIZE = 100;

export type OrganizationPage = {
  members: unknown[];
  employees: unknown[];
  assignments: unknown[];
  departments: unknown[];
  locations: unknown[];
  teams: unknown[];
  teamMemberships: unknown[];
  invitations: unknown[];
  pagination?: Record<string, { hasMore: boolean; limit?: number; offset?: number; nextCursor?: string | null }>;
};

export async function requestOrganizationSnapshot(
  path: string,
  cache: Map<string, { etag: string; page: OrganizationPage }>,
  request: typeof fetch = fetch,
): Promise<OrganizationPage> {
  const cached = cache.get(path);
  const response = await request(`/api${path}`, {
    credentials: "include",
    cache: "no-store",
    headers: cached ? { "If-None-Match": cached.etag } : {},
  });
  if (response.status === 304 && cached) return cached.page;
  const page = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(page.error ?? "Could not refresh the organization directory.");
  const etag = response.headers.get("ETag");
  if (etag) cache.set(path, { etag, page });
  return page as OrganizationPage;
}

type OrganizationLengths = Pick<OrganizationPage, "employees" | "assignments" | "departments" | "locations" | "teams" | "invitations" | "teamMemberships">;

const organizationCollectionKeys = [
  "employees", "invitations", "assignments", "departments", "locations", "teams", "teamMemberships",
] as const;
type OrganizationCollection = typeof organizationCollectionKeys[number];

function pageQuery(lengths: OrganizationLengths, pageIndexes: Record<OrganizationCollection, number>, cursors: Partial<Record<OrganizationCollection, string>>): string {
  const params = new URLSearchParams();
  for (const key of organizationCollectionKeys) {
    const pageIndex = pageIndexes[key];
    const limit = Math.min(PAGE_SIZE, Math.max(1, lengths[key].length - pageIndex * PAGE_SIZE));
    params.set(`${key}Limit`, String(limit));
    const cursor = cursors[key];
    if (cursor) params.set(`${key}Cursor`, cursor);
    else params.set(`${key}Offset`, String(pageIndex * PAGE_SIZE));
  }
  return params.toString();
}

/** Refresh exactly the organization pages the viewer has already loaded. */
export async function fetchOrganizationPages<T extends OrganizationPage>(
  workspaceId: number,
  current: OrganizationLengths,
  request: (path: string) => Promise<T>,
): Promise<T[]> {
  const pageTargets = Object.fromEntries(organizationCollectionKeys.map((key) => [
    key, Math.max(1, Math.ceil(current[key].length / PAGE_SIZE)),
  ])) as Record<OrganizationCollection, number>;
  const pageIndexes = Object.fromEntries(organizationCollectionKeys.map((key) => [key, 0])) as Record<OrganizationCollection, number>;
  let cursors: Partial<Record<OrganizationCollection, string>> = Object.fromEntries(
    organizationCollectionKeys.map((key) => [key, "start"]),
  );
  let active = new Set<OrganizationCollection>(organizationCollectionKeys);
  const pages: T[] = [];
  while (active.size > 0) {
    // Sequential requests keep a refresh bounded and avoid a request burst.
    const response = await request(`/communities/${workspaceId}/organization-snapshot?${pageQuery(current, pageIndexes, cursors)}`);
    const nextPage = {
      ...response,
      members: active.has("employees") ? response.members : [],
      employees: active.has("employees") ? response.employees : [],
      invitations: active.has("invitations") ? response.invitations : [],
      assignments: active.has("assignments") ? response.assignments : [],
      departments: active.has("departments") ? response.departments : [],
      locations: active.has("locations") ? response.locations : [],
      teams: active.has("teams") ? response.teams : [],
      teamMemberships: active.has("teamMemberships") ? response.teamMemberships : [],
    };
    pages.push(nextPage);
    const remaining = new Set<OrganizationCollection>();
    for (const key of active) {
      pageIndexes[key] += 1;
      const pagination = response.pagination?.[key];
      if (pageIndexes[key] < pageTargets[key] && pagination?.nextCursor) {
        cursors[key] = pagination.nextCursor;
        remaining.add(key);
      } else if (pageIndexes[key] < pageTargets[key] && pagination && !("nextCursor" in pagination) && pagination.hasMore) {
        delete cursors[key];
        remaining.add(key);
      } else {
        delete cursors[key];
      }
    }
    active = remaining;
  }
  return pages;
}

export function mergeOrganizationPages<T extends OrganizationPage>(current: T, pages: OrganizationPage[]): T {
  if (pages.length === 0) return current;
  const pageCount = (items: unknown[]) => Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const combined = <K extends keyof OrganizationPage>(key: K, count: number) =>
    pages.slice(0, count).flatMap((page) => page[key] as unknown[]);
  const paginationFor = (key: string, items: unknown[]) =>
    pages[Math.min(pages.length, pageCount(items)) - 1]?.pagination?.[key];
  const employeePages = pageCount(current.employees);
  const assignmentPages = pageCount(current.assignments);
  const departmentPages = pageCount(current.departments);
  const locationPages = pageCount(current.locations);
  const teamPages = pageCount(current.teams);
  const membershipKeys = new Set<string>();
  return {
    ...current,
    members: combined("members", employeePages),
    employees: combined("employees", employeePages).map((employee) => ({
      ...(employee as object),
      teamIds: pages.flatMap((page) => page.teamMemberships)
        .filter((row) => (row as { userId: string; status: string }).userId === (employee as { userId: string }).userId
          && (row as { status: string }).status === "active")
        .map((row) => (row as { teamId: number }).teamId),
    })),
    assignments: combined("assignments", assignmentPages),
    departments: combined("departments", departmentPages),
    locations: combined("locations", locationPages),
    teams: combined("teams", teamPages),
    teamMemberships: combined("teamMemberships", pageCount(current.teamMemberships)).filter((membership) => {
      const item = membership as { teamId: number; userId: string };
      const key = `${item.teamId}:${item.userId}`;
      if (membershipKeys.has(key)) return false;
      membershipKeys.add(key);
      return true;
    }),
    invitations: combined("invitations", pageCount(current.invitations)),
    pagination: {
      ...current.pagination,
      employees: paginationFor("employees", current.employees) ?? current.pagination?.employees,
      assignments: paginationFor("assignments", current.assignments) ?? current.pagination?.assignments,
      departments: paginationFor("departments", current.departments) ?? current.pagination?.departments,
      locations: paginationFor("locations", current.locations) ?? current.pagination?.locations,
      teams: paginationFor("teams", current.teams) ?? current.pagination?.teams,
      invitations: paginationFor("invitations", current.invitations) ?? current.pagination?.invitations,
      teamMemberships: paginationFor("teamMemberships", current.teamMemberships) ?? current.pagination?.teamMemberships,
    },
  } as T;
}

type FreshnessOptions<T> = {
  workspaceId: number | null;
  enabled: boolean;
  intervalMs?: number;
  fetchFresh: (workspaceId: number) => Promise<T>;
  applyFresh: (workspaceId: number, value: T) => void;
  onError: (error: unknown) => void;
};

/**
 * Polls only while visible. Generations prevent responses from a previous
 * workspace, mutation, visibility period, or unmounted component being applied.
 */
export function useOrganizationFreshness<T>({
  workspaceId,
  enabled,
  intervalMs = 30_000,
  fetchFresh,
  applyFresh,
  onError,
}: FreshnessOptions<T>): void {
  const generation = useRef(0);
  const inFlight = useRef(false);
  const fetchRef = useRef(fetchFresh);
  const applyRef = useRef(applyFresh);
  const errorRef = useRef(onError);
  fetchRef.current = fetchFresh;
  applyRef.current = applyFresh;
  errorRef.current = onError;

  useEffect(() => {
    ++generation.current;
    if (!enabled || workspaceId === null) return;

    let timer: number | undefined;
    const refresh = async () => {
      if (inFlight.current || document.visibilityState !== "visible") return;
      const token = generation.current;
      inFlight.current = true;
      try {
        const value = await fetchRef.current(workspaceId);
        if (generation.current === token) applyRef.current(workspaceId, value);
      } catch (error) {
        if (generation.current === token) errorRef.current(error);
      } finally {
        // A newer generation cannot have started while this flag was set.
        inFlight.current = false;
      }
    };
    const schedule = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "visible") timer = window.setInterval(() => void refresh(), intervalMs);
    };
    const onVisibility = () => {
      ++generation.current;
      schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      ++generation.current;
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, workspaceId]);
}