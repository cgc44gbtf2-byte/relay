// Scan in bounded batches because permission checks can be more complex than a SQL
// predicate. The public offset counts visible records, never hidden records.
export function parseCollectionPage(query: { limit?: unknown; offset?: unknown }, maxLimit: number): { limit: number; offset: number } | null {
  const { limit, offset } = query;
  if ((limit !== undefined && (typeof limit !== "string" || !/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) > maxLimit))
    || (offset !== undefined && (typeof offset !== "string" || !/^(0|[1-9]\d*)$/.test(offset) || !Number.isSafeInteger(Number(offset))))) return null;
  return { limit: limit === undefined ? maxLimit : Number(limit), offset: offset === undefined ? 0 : Number(offset) };
}

export async function visibleListPage<T extends { id: number; name: string }>(
  page: { limit: number; offset: number },
  batchSize: number,
  fetch: (after: T | null) => Promise<T[]>,
  visible: (rows: T[]) => Promise<T[]>,
): Promise<{ rows: T[]; hasMore: boolean }> {
  const selected: T[] = [];
  let after: T | null = null;
  let skipped = 0;
  while (selected.length <= page.limit) {
    const batch = await fetch(after);
    if (!batch.length) break;
    after = batch[batch.length - 1];
    for (const row of await visible(batch)) {
      if (skipped < page.offset) skipped += 1;
      else selected.push(row);
      if (selected.length > page.limit) break;
    }
    if (batch.length < batchSize) break;
  }
  return { rows: selected.slice(0, page.limit), hasMore: selected.length > page.limit };
}