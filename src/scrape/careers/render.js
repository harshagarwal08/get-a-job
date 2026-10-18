// Headless-Chrome rendering for JS-only careers pages.
// Network containment:
//  - Chrome runs behind an in-process forward proxy (./proxy.js) with
//    --proxy-bypass-list=<-loopback>, so every connection (HTTP, WebSocket, workers, iframes)
//    is resolved and IP-checked by us and connected to the checked IP (no DNS rebinding).
//  - WebSocket / RTCPeerConnection / WebTransport are removed before page scripts run,
//    WebRTC is restricted to proxied UDP (= none), service workers are bypassed.
//  - Requests are intercepted too: images/fonts/media dropped, non-http(s) aborted,
//    main-frame navigations re-checked against robots.txt.
// One Chrome at a time: renders are serialized through a module-level queue and share one
// browser (+ proxy) that is closed when the last crawl using it finishes.
import { assertPublicHost, MAX_BODY_BYTES } from '../safeFetch.js';
import { BROWSER_HEADERS } from '../http.js';
import { startProxy } from './proxy.js';

export const RENDER_TIMEOUT_MS = 20_000;
const BLOCKED_TYPES = new Set(['image', 'font', 'media']);

/** Runs before any page script: remove APIs that open non-HTTP or peer-to-peer connections. */
export const LOCKDOWN_SCRIPT = `(() => {
  for (const k of ['WebSocket', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'WebTransport']) {
    try { delete globalThis[k]; } catch {}
    try { Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  try { Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined, configurable: false }); } catch {}
})();`;

/** Chrome flags; the proxy URL is per launch. */
export function chromeArgs(proxyUrl) {
  return [
    '--disable-gpu',
    `--proxy-server=${proxyUrl}`,
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
  ];
}

/** Launch puppeteer Chrome with extra args, reusing src/resume/browser.js executable discovery. */
async function launchChrome({ args }) {
  const puppeteer = (await import('puppeteer')).default;
  const { executableCandidates, noSandboxAllowed } = await import('../../resume/browser.js');
  const errors = [];
  const attempts = noSandboxAllowed() ? [[], ['--no-sandbox']] : [[]];
  for (const executablePath of executableCandidates(puppeteer)) {
    for (const extra of attempts) {
      try { return await puppeteer.launch({ headless: true, executablePath, args: [...args, ...extra] }); } catch (err) {
        errors.push(`${executablePath}: ${err.message.split('\n')[0]}`);
      }
    }
  }
  throw new Error(['Could not launch Chrome for rendering careers pages.', ...errors].join('\n'));
}

// ---------- serialization + shared browser ----------

let renderChain = Promise.resolve();
/** Run fn after every previously queued render finished (one page in Chrome at a time). */
function serialized(fn) {
  const p = renderChain.then(fn, fn);
  renderChain = p.catch(() => {});
  return p;
}

/**
 * A browser + proxy shared by its users; closed when the last user releases it.
 * @param {{launch?: Function, lookup?: Function, dial?: Function}} o
 */
export function createPool({ launch = launchChrome, lookup, dial } = {}) {
  let users = 0;
  let state = null; // Promise<{browser, proxy}>
  return {
    async acquire() {
      users++;
      if (!state) {
        state = (async () => {
          const proxy = await startProxy({ ...(lookup ? { lookup } : {}), ...(dial ? { dial } : {}) });
          try { return { proxy, browser: await launch({ args: chromeArgs(proxy.url) }) }; } catch (e) { await proxy.close(); throw e; }
        })();
        state.catch(() => { state = null; });
      }
      return state;
    },
    async release() {
      users = Math.max(0, users - 1);
      if (users || !state) return;
      const s = state;
      state = null;
      const st = await s.catch(() => null);
      await st?.browser.close().catch(() => {});
      await st?.proxy.close().catch(() => {});
    },
    get users() { return users; },
  };
}

let defaultPool = null;

/**
 * Per-crawl renderer. render() returns the page HTML after network idle.
 * @param {object} o
 * @param {{robotsOk: (u: string) => Promise<boolean>, remaining: () => number}} o.fetcher
 * @param {Function} [o.launch] ({args}) => browser (tests inject a fake/own launcher; gets its own pool)
 * @param {Function} [o.lookup] DNS lookup for the private-IP guard and the proxy
 * @param {Function} [o.dial] proxy upstream connector (tests)
 */
export function createRenderer({ fetcher, launch, lookup, dial } = {}) {
  const pool = launch || lookup || dial ? createPool({ launch, lookup, dial }) : (defaultPool ??= createPool());
  const hostOk = new Map();
  const stats = { renders: 0 };

  const publicHost = (hostname) => {
    if (!hostOk.has(hostname)) hostOk.set(hostname, assertPublicHost(hostname, lookup).then(() => true, () => false));
    return hostOk.get(hostname);
  };

  async function renderNow(url) {
    const budget = Math.min(RENDER_TIMEOUT_MS, fetcher.remaining() - 1000);
    if (budget < 3000) throw new Error('not enough time left to render');
    const { browser } = await acquireOnce();
    const page = await browser.newPage();
    stats.renders++;
    try {
      await page.setBypassServiceWorker?.(true);
      await page.evaluateOnNewDocument(LOCKDOWN_SCRIPT);
      await page.setUserAgent(BROWSER_HEADERS['user-agent']);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        (async () => {
          if (req.isInterceptResolutionHandled?.()) return;
          const rurl = req.url();
          if (BLOCKED_TYPES.has(req.resourceType())) return req.abort('blockedbyclient');
          let ru;
          try { ru = new URL(rurl); } catch { return req.abort('blockedbyclient'); }
          if (ru.protocol === 'data:' || ru.protocol === 'blob:') return req.continue();
          if (ru.protocol !== 'http:' && ru.protocol !== 'https:') return req.abort('blockedbyclient');
          if (!(await publicHost(ru.hostname))) return req.abort('addressunreachable');
          if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !(await fetcher.robotsOk(rurl))) return req.abort('blockedbyclient');
          return req.continue();
        })().catch(() => { try { req.abort('failed'); } catch { /* already handled */ } });
      });
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: budget });
      } catch (e) {
        if (!/timeout/i.test(e.message)) throw e; // slow pages: take what has rendered
      }
      let html = '';
      for (let i = 0; i < 3; i++) {
        try { html = await page.content(); break; } catch (e) {
          if (i === 2 || !/context was destroyed|navigat/i.test(e.message)) throw e;
          await new Promise((r) => setTimeout(r, 1500)); // client-side redirect in progress
        }
      }
      return { url: page.url() || url, html: html.length > MAX_BODY_BYTES ? html.slice(0, MAX_BODY_BYTES) : html };
    } finally {
      await page.close().catch(() => {});
    }
  }

  // acquire the pool once per renderer; release on close()
  let held = null;
  const acquireOnce = () => (held ??= pool.acquire().catch((e) => { held = null; pool.release(); throw e; }));

  /**
   * @param {string} url
   * @returns {Promise<{url: string, html: string}>}
   */
  async function render(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`refusing to render ${u.protocol} URL`);
    await assertPublicHost(u.hostname, lookup);
    if (!(await fetcher.robotsOk(url))) {
      const err = new Error(`robots.txt disallows ${url}`);
      err.code = 'ROBOTS';
      throw err;
    }
    return serialized(() => renderNow(url));
  }

  async function close() {
    if (held) { held = null; await pool.release(); }
  }

  return { render, close, stats, get launched() { return held !== null; } };
}
