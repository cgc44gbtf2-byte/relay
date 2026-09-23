import type { CorsOptions } from "cors";

const CORS_ALLOWED_ORIGINS = "CORS_ALLOWED_ORIGINS";
const REPLIT_DOMAINS = "REPLIT_DOMAINS";
const REPLIT_DEV_DOMAIN = "REPLIT_DEV_DOMAIN";

type Environment = Record<string, string | undefined>;

function originFromConfiguredValue(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;

  // Replit domain variables contain hostnames, while CORS_ALLOWED_ORIGINS
  // contains complete origins.
  const url = candidate.includes("://")
    ? new URL(candidate)
    : new URL(`https://${candidate}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

export function trustedOrigins(environment: Environment = process.env): Set<string> {
  const configured = [
    ...(environment[CORS_ALLOWED_ORIGINS]?.split(",") ?? []),
    ...(environment[REPLIT_DOMAINS]?.split(",") ?? []),
    ...(environment[REPLIT_DEV_DOMAIN]?.split(",") ?? []),
  ];
  return new Set(
    configured.flatMap((value) => {
      try {
        const origin = originFromConfiguredValue(value);
        return origin ? [origin] : [];
      } catch {
        return [];
      }
    }),
  );
}

export function isTrustedOrigin(origin: string, environment?: Environment): boolean {
  try {
    return trustedOrigins(environment).has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    // Browsers omit Origin for same-origin requests. Keep those requests
    // working without weakening checks for cross-origin requests.
    callback(null, !origin || isTrustedOrigin(origin));
  },
};