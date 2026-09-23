export const MAX_QUERY_LENGTH = 200;

export function isValidQuery(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_QUERY_LENGTH;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}