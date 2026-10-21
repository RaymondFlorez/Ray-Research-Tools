import { describe, expect, it } from 'vitest';
import { DataPlaneError, RemotePointInTime } from '../src/remote.js';

/** Records what was asked and answers with a canned body. */
function recorder(status = 200, body: unknown = { observations: [], blocked: [] }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe('RemotePointInTime', () => {
  it('reads a pinned canvas as of its pin, and a live one as of now', async () => {
    const { calls, fetcher } = recorder();
    const remote = new RemotePointInTime({ baseUrl: 'http://dp:8740/', user: 'analyst', fetch: fetcher });
    await remote.read('NVDA.revenue', { mode: 'pinned', asof: '2024-08-05T09:30:00Z' }, () => '2026-10-21T00:00:00Z');
    await remote.read('NVDA.revenue', { mode: 'live' }, () => '2026-10-21T00:00:00Z', { from: '2024-01-01' });
    expect(calls.map((c) => c.url)).toEqual([
      'http://dp:8740/v1/asof?key=NVDA.revenue&knowledge=2024-08-05T09%3A30%3A00Z',
      'http://dp:8740/v1/asof?key=NVDA.revenue&knowledge=2026-10-21T00%3A00%3A00Z&from=2024-01-01',
    ]);
    expect(new Headers(calls[0]!.init!.headers).get('X-Picasso-User')).toBe('analyst');
  });

  it('surfaces a refusal as an error with the server\'s reason, not as an empty read', async () => {
    const { fetcher } = recorder(401, { error: 'unknown user' });
    const remote = new RemotePointInTime({ baseUrl: 'http://dp', user: 'nobody', fetch: fetcher });
    await expect(remote.asOf({ key: 'k', knowledgeTime: '2024-01-01' })).rejects.toThrow(DataPlaneError);
    await expect(remote.asOf({ key: 'k', knowledgeTime: '2024-01-01' })).rejects.toThrow('data plane 401: unknown user');
  });

  it('posts facts as a JSON array, and reports a refused append', async () => {
    const ok = recorder(200, { appended: 2 });
    const remote = new RemotePointInTime({ baseUrl: 'http://dp', user: 'loader', fetch: ok.fetcher });
    const facts = [
      { key: 'k', validTime: '2024-01-01', knowledgeTime: '2024-01-02', value: 1, dataClass: 'public' as const },
      { key: 'k', validTime: '2024-01-01', knowledgeTime: '2024-02-02', value: 2, dataClass: 'licensed' as const, vendor: 'v' },
    ];
    expect(await remote.append(facts)).toBe(2);
    expect(ok.calls[0]!.init!.method).toBe('POST');
    expect(JSON.parse(ok.calls[0]!.init!.body as string)).toEqual(facts);
    const refused = recorder(403, { error: 'this user may read, not append' });
    await expect(new RemotePointInTime({ baseUrl: 'http://dp', user: 'pm', fetch: refused.fetcher }).append(facts)).rejects.toThrow('403');
  });
});
