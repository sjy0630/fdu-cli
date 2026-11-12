import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TreeholeClient, type RawFetch } from '../src/services/treehole';
import { Session } from '../src/core/session';
import { Store } from '../src/core/store';

/** 少等：探测不重试、路线和 WebVPN 状态跨命令记住 */

const json = (url: string, body: unknown) => ({ status: 200, url, contentType: 'application/json', text: JSON.stringify(body) });

describe('树洞选路线', () => {
  it('探测直连只试一次（3 秒、不重试）；连不上走 WebVPN，并记到本地、提示用户', async () => {
    const calls: { url: string; init: Parameters<RawFetch>[1] }[] = [];
    let saved: unknown = null;
    const logs: string[] = [];
    const client = new TreeholeClient({
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.startsWith('https://forum.fduhole.com')) throw new Error('Timeout 3000ms exceeded');
        return json(url, { access: 'a', refresh: 'r' });
      },
      ensureWebvpn: async () => undefined,
      tokens: { get: () => null, set: () => undefined },
      route: { get: () => null, set: (r) => { saved = r; } },
      log: (m) => logs.push(m),
      now: () => 0,
    });
    await client.login('x@m.fudan.edu.cn', 'pw');
    expect(calls[0].init).toMatchObject({ timeoutMs: 3000, retries: 0 });
    expect(calls[1].url).toContain('webvpn.fudan.edu.cn');
    expect(saved).toEqual({ via: 'webvpn', until: 600_000 });
    expect(logs.join()).toContain('WebVPN');
  });

  it('本地记着走 WebVPN 时不再探测，直接走', async () => {
    const urls: string[] = [];
    const client = new TreeholeClient({
      fetch: async (url) => { urls.push(url); return json(url, { access: 'a', refresh: 'r' }); },
      ensureWebvpn: async () => undefined,
      tokens: { get: () => null, set: () => undefined },
      route: { get: () => ({ via: 'webvpn', until: 1000 }), set: () => undefined },
      now: () => 0,
    });
    await client.login('x@m.fudan.edu.cn', 'pw');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('webvpn.fudan.edu.cn');
  });
});

describe('WebVPN 状态跨命令记住', () => {
  it('一条命令确认过，下一条命令（新的会话）也能用；作废后就没了', () => {
    process.env.FDU_HOME = mkdtempSync(join(tmpdir(), 'fdu-'));
    const a = new Session(new Store());
    a.webvpnAliveAt = 123;
    expect(new Session(new Store()).webvpnAliveAt).toBe(123);
    a.webvpnAliveAt = undefined;
    expect(new Session(new Store()).webvpnAliveAt).toBeUndefined();
  });
});
