import type { IncomingHttpHeaders } from "node:http";

const DEFAULT_LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const LOCAL_BIND_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PUBLIC_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export type ServerSecurityConfig = {
  host: string;
  corsOrigins: string[];
  apiAuthToken?: string;
  publicBind: boolean;
};

function splitList(value: string) {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function cleanToken(value: string | undefined) {
  const token = value?.trim();
  return token ? token : undefined;
}

export function isPublicBindHost(host: string) {
  const normalized = host.trim().toLowerCase();
  if (PUBLIC_BIND_HOSTS.has(normalized)) return true;
  return !LOCAL_BIND_HOSTS.has(normalized);
}

export function buildServerSecurityConfig(env: NodeJS.ProcessEnv = process.env): ServerSecurityConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const corsOrigins = env.WEB_ORIGIN?.trim() ? splitList(env.WEB_ORIGIN) : DEFAULT_LOCAL_ORIGINS;
  const apiAuthToken = cleanToken(env.API_AUTH_TOKEN);
  const publicBind = isPublicBindHost(host);
  const unsafePublicBind = env.ALLOW_UNAUTHENTICATED_PUBLIC_BIND === "true";

  if (publicBind && !apiAuthToken && !unsafePublicBind) {
    throw new Error(
      "Refusing to bind API server publicly without API_AUTH_TOKEN. Set HOST=127.0.0.1, configure API_AUTH_TOKEN, or explicitly set ALLOW_UNAUTHENTICATED_PUBLIC_BIND=true for unsafe local experiments."
    );
  }

  return {
    host,
    corsOrigins,
    ...(apiAuthToken ? { apiAuthToken } : {}),
    publicBind
  };
}

export function isCorsOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]) {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

export function isApiRequestAuthorized(headers: IncomingHttpHeaders, apiAuthToken: string | undefined) {
  if (!apiAuthToken) return true;

  const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (authorization?.trim() === `Bearer ${apiAuthToken}`) return true;

  const headerToken = headers["x-webcode-token"];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  return token?.trim() === apiAuthToken;
}
