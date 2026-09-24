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
  pagination?: Record<string, { hasMore: boolean; limit?: number; offset?: number }>;
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

type OrganizationLengths = Pick<OrganizationPage, "employees" | "assignments" | "departments" | "locations" | "teams" | "invitations">;

function pageQuery(lengths: OrganizationLengths, offset: number): string {
  const limit = (items: unknown[]) => offset === 0
    ? PAGE_SIZE
    : Math.min(PAGE_SIZE, Math.max(1, items.length - offset));
  const params = new URLSearchParams({
    employeesLimit: String(limit(lengths.employees)),
    employeesOffset: String(offset),
    invitationsLimit: String(limit(lengths.invitations)),
    invitationsOffset: String(offset),
    assignmentsLimit: String(limit(lengths.assignments)),
    assignmentsOffset: String(offset),
    departmentsLimit: String(limit(lengths.departments)),
    departmentsOffset: String(offset),
    locationsLimit: String(limit(lengths.locations)),
    locationsOffset: String(offset),
    teamsLimit: String(limit(lengths.teams)),
    teamsOffset: String(offset),
  });
  return params.toString();
}

/** Refresh exactly the organization pages the viewer has already loaded. */
export async function fetchOrganizationPages<T extends OrganizationPage>(
  workspaceId: number,
  current: OrganizationLengths,
  request: (path: string) => Promise<T>,
): Promise<T[]> {
  const loaded = Math.max(
    PAGE_SIZE,
    current.employees.length,
    current.assignments.length,
    current.departments.length,
    current.locations.length,
    current.teams.length,
    current.invitations.length,
  );
  const pages: T[] = [];
  for (let offset = 0; offset < loaded; offset += PAGE_SIZE) {
    // Sequential requests keep a refresh bounded and avoid a request burst.
    pages.push(await request(`/communities/${workspaceId}/organization-snapshot?${pageQuery(current, offset)}`));
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
    employees: combined("employees", employeePages),
    assignments: combined("assignments", assignmentPages),
    departments: combined("departments", departmentPages),
    locations: combined("locations", locationPages),
    teams: combined("teams", teamPages),
    teamMemberships: combined("teamMemberships", employeePages).filter((membership) => {
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