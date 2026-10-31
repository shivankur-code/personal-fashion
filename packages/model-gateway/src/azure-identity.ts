// Managed identity tokens inside Azure Container Apps, without an SDK.
// Container Apps sets IDENTITY_ENDPOINT and IDENTITY_HEADER for apps and jobs with an identity.

export type TokenProvider = (resource: string) => Promise<string>;

interface CachedToken { token: string; expiresAt: number }

export function managedIdentityTokenProvider(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): TokenProvider {
  const cache = new Map<string, CachedToken>();
  return async (resource: string) => {
    const hit = cache.get(resource);
    if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
    const endpoint = env.IDENTITY_ENDPOINT;
    const header = env.IDENTITY_HEADER;
    if (!endpoint || !header) throw new Error('No managed identity here (IDENTITY_ENDPOINT/IDENTITY_HEADER missing)');
    const url = new URL(endpoint);
    url.searchParams.set('resource', resource);
    url.searchParams.set('api-version', '2019-08-01');
    if (env.AZURE_CLIENT_ID) url.searchParams.set('client_id', env.AZURE_CLIENT_ID);
    const res = await fetchImpl(url, { headers: { 'X-IDENTITY-HEADER': header }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`managed identity token failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { access_token: string; expires_on?: string | number };
    const expiresAt = body.expires_on ? Number(body.expires_on) * 1000 : Date.now() + 30 * 60_000;
    cache.set(resource, { token: body.access_token, expiresAt });
    return body.access_token;
  };
}
