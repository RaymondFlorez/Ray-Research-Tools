/** A browser, as far as cookies and redirects go. Cookies are kept by name, across hosts. */
export class Browser {
  jar = new Map<string, string>();
  async go(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair!.indexOf('=');
      const [k, v] = [pair!.slice(0, i).trim(), pair!.slice(i + 1).trim()];
      if (attrs.some((a) => a.trim().toLowerCase() === 'max-age=0') || attrs.some((a) => /^expires=thu, 01 jan 1970/i.test(a.trim()))) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }
  /** Follows redirects (302 or 303) through the provider and back; returns where it landed. */
  async signIn(auth: string, user: string, returnTo = '/apps/canvas-demo/shared.html'): Promise<URL> {
    let res = await this.go(`${auth}/auth/login?return=${encodeURIComponent(returnTo)}&login_hint=${user}`);
    for (let i = 0; i < 10 && (res.status === 302 || res.status === 303); i += 1) {
      const loc = new URL(res.headers.get('location')!, res.url || auth);
      if (loc.pathname.startsWith('/apps/') || loc.pathname === '/') return loc;
      res = await this.go(loc.toString());
    }
    throw new Error(`sign-in ended at ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}
