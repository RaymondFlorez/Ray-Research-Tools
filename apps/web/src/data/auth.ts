/**
 * Bearer token for the API when it runs with GEOGLOBE_AUTH_REQUIRED=true.
 *
 * v0.1 has no login UI of its own: an identity-aware proxy or login page hands the app a
 * JWT by redirecting to `…/#token=<jwt>`. The token is moved into sessionStorage (so it
 * survives reloads but not the tab) and scrubbed from the URL. A fragment is used rather
 * than a query string because fragments never reach servers, proxies or access logs.
 */
const TOKEN_KEY = 'geoglobe.token';

function captureFromFragment(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get('token');
  if (!token) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage blocked: the token works for this page load only.
    memoryToken = token;
  }
  params.delete('token');
  const rest = params.toString();
  const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
  window.history.replaceState(null, '', url);
}

let memoryToken: string | null = null;
captureFromFragment();

export function getAuthToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}
