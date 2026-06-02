import { randomUUID } from 'node:crypto';
import type { SessionIdentity } from '@mcp-abap-adt/llm-agent';

/** Opaque session-id format: UUID-compatible, defensive upper bound. */
const ID_RE = /^[A-Za-z0-9-]{1,128}$/;

export interface ResolveSessionInput {
  cookieHeader: string | undefined;
  cookieName: string;
  maxAgeSeconds: number;
  /** True when the request arrived over HTTPS; adds the `Secure` attribute. */
  isHttps: boolean;
}

export interface ResolveSessionResult {
  identity: SessionIdentity;
  /** true when a new id was minted (caller must send `setCookie`). */
  minted: boolean;
  /** Set-Cookie header value, present only when `minted`. */
  setCookie?: string;
}

function parseCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const v = part.slice(eq + 1).trim();
      if (v.length > 0) return v;
    }
  }
  return undefined;
}

export function resolveSessionIdentity(
  input: ResolveSessionInput,
): ResolveSessionResult {
  const existing = parseCookie(input.cookieHeader, input.cookieName);
  // Validate: never adopt a malformed/empty client value as a sessionId.
  if (existing && ID_RE.test(existing)) {
    return { identity: { sessionId: existing }, minted: false };
  }
  const sessionId = randomUUID();
  const attrs = [
    `${input.cookieName}=${sessionId}`,
    `Max-Age=${input.maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (input.isHttps) attrs.push('Secure');
  return { identity: { sessionId }, minted: true, setCookie: attrs.join('; ') };
}
