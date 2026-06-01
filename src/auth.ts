// auth.ts — federate Bearer validation to the gateway (ADR-1). Realtime NEVER validates keys locally
// and holds no key-store creds; it asks api.wave.online/v1/verify and trusts the canonical resolver.
// Fail-closed: no header, a non-200, or an unreachable gateway → deny.
import type { Env } from "./types";

export interface Principal {
  organizationId: string;
  scopes: string[];
  rateLimitTier: string;
  keyPrefix: string;
}

const GATEWAY_DEFAULT = "https://api.wave.online";

/**
 * Verify the request's Bearer against the gateway's /v1/verify. Returns the principal or null.
 * Accepts the key via the `Authorization: Bearer` header OR a `?access_token=` query param — browser
 * WebSocket clients (and the SDK's RealtimeChannel) can't set headers on the upgrade, so the token
 * rides the query over wss. The token is forwarded to the gateway as a Bearer; never logged.
 */
export async function federateVerify(req: Request, env: Env): Promise<Principal | null> {
  let auth = req.headers.get("Authorization");
  if (!auth) {
    const qp = new URL(req.url).searchParams.get("access_token");
    if (qp) auth = `Bearer ${qp}`;
  }
  if (!auth || !/^Bearer\s+\S/i.test(auth)) return null;
  const origin = (env.GATEWAY_ORIGIN || GATEWAY_DEFAULT).replace(/\/+$/, "");
  try {
    const r = await fetch(`${origin}/v1/verify`, { method: "POST", headers: { Authorization: auth } });
    if (!r.ok) return null;
    const body = (await r.json()) as { ok?: boolean; principal?: Principal };
    return body.ok && body.principal ? body.principal : null;
  } catch {
    return null; // gateway unreachable → fail-closed deny
  }
}

/** True if the principal carries the scope (or no scope map is enforced yet — see worker note). */
export function hasScope(p: Principal, scope: string): boolean {
  return p.scopes.includes(scope) || p.scopes.includes("*");
}
