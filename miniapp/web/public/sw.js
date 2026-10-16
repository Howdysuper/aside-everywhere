/**
 * Service worker: installability, and nothing clever.
 *
 * A service worker is the one piece of this app that can break it in a way
 * a reload does not fix, because a bad cache entry outlives the page that
 * created it. So the rules here are deliberately narrow.
 *
 *   /assets/*  content-hashed by Vite, so a given URL's bytes never change.
 *              Safe to serve from cache first and keep forever.
 *   /icons/*   same idea, changes only when the file name does.
 *   /art/*     versioned artwork, cached after its first fetch.
 *   /api, /ws  never touched. A cached API response is a wrong answer, and a
 *              stale session list is worse than a spinner.
 *   navigation network-first, cache as fallback, so a new build is picked up
 *              the moment the Mac is reachable and the shell still opens when
 *              it is not.
 *   relay list the `aside-relays` meta tag's origins, scraped from each fresh
 *              shell and kept under their own cache key, so the offline page
 *              can offer the backup addresses when the primary is down.
 *
 * The version string is the whole cache-busting story: bump it and every old
 * cache is dropped on activate.
 */
/*
 * v2: the search rewrite. v1 shipped a stylesheet with an unclosed rule
 * that silently voided every rule after it, and because `/assets/*` is
 * cache-first and never revalidated, a phone that fetched it once kept
 * rendering the broken build even after the server was fixed. Content
 * hashing does not save you here: it only helps if the HTML referencing
 * the new hash is itself fresh, and the shell falls back to cache the
 * moment the Mac is briefly unreachable. Deleting every non-matching
 * cache on activate is the only reliable way out of that state.
 */
/*
 * Stamped at build time by the `sw-build-id` plugin in vite.config.ts, from
 * a hash of the emitted asset filenames. It was a hand-written string with
 * a comment telling the next person to remember to bump it, which is the
 * kind of instruction that gets forgotten exactly once and then costs a
 * phone that renders unstyled until someone reinstalls the app.
 *
 * The failure it prevents, reproduced before this changed: a cached shell
 * outlives the assets it points at. `npm run build` empties dist and emits
 * new content hashes, so the old `/assets/index-<hash>.css` is gone from
 * the server. The shell in the cache still asks for it, the asset handler
 * misses, the fetch 404s, and the app paints with no stylesheet. Nothing
 * recovers from that on its own, because both caches are behaving exactly
 * as designed.
 *
 * Tying the version to the build means every deploy invalidates the shell,
 * so the shell and the assets can never disagree about which build it is.
 */
const VERSION = 'aside-__BUILD_ID__';

/**
 * How long a cold start waits for the Mac before painting from cache.
 *
 * Straight network-first made every launch block on a round trip to the
 * Mac over the tailnet for the shell, and only then start fetching ~575 KB
 * of hashed assets. When the Mac is awake and nearby that is a couple of
 * hundred milliseconds; when it is waking, on another network, or the
 * tunnel is reconnecting, it is seconds of white screen.
 *
 * Straight cache-first fixes the stall and introduces a worse problem: a
 * shell cached from an older build points at older asset hashes, which are
 * themselves cached, so a new build would not appear until the second
 * launch. During active development that reads as "my change did not ship".
 *
 * Racing the two removes both failure modes. The network wins whenever it
 * is merely normal-slow, so the freshest build is what renders; the cache
 * only steps in when waiting would have been visible anyway, and the
 * network response still lands in the cache for next time.
 */
const SHELL_TIMEOUT_MS = 350;
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const SHELL_URL = '/app';
const ART_URL = '/art/zeron-liquid-dots-v2.webp';
const RELAY_LIST_KEY = 'aside-relay-list';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Best-effort: a failed precache must not block installation, or the
      // app becomes uninstallable whenever the Mac happens to be asleep.
      await Promise.allSettled([
        cache.add(SHELL_URL),
        cache.add(ART_URL),
      ]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isImmutable(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/art/')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  // The Mac page is a different app on the same address. Never answer it
  // with the phone shell (or cache it as the phone shell): leave it to the
  // network entirely.
  if (url.pathname === '/desk' || url.pathname.startsWith('/desk.') || url.pathname.startsWith('/desk/')) return;

  if (isImmutable(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const res = await fetch(request);
        if (res.ok) {
          const cache = await caches.open(ASSETS);
          cache.put(request, res.clone());
        }
        return res;
      })(),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        // Kicked off first so the clock starts before anything is awaited.
        const network = fetch(request)
          .then(async (res) => {
            if (res.ok) {
              const cache = await caches.open(SHELL);
              await cache.put(SHELL_URL, res.clone());
              // Scrape the failover list out of the fresh shell for the
              // offline page below. Best-effort: a shell without the tag
              // (Telegram build, old server) leaves the previous list alone.
              try {
                const html = await res.clone().text();
                const match = /<meta\s+name="aside-relays"\s+content="([^"]*)"\s*\/?>/.exec(html);
                if (match) {
                  const origins = match[1]
                    .split(/\s+/)
                    .filter((o) => /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(o));
                  if (origins.length) {
                    await cache.put(
                      RELAY_LIST_KEY,
                      new Response(origins.join(' '), {
                        headers: { 'content-type': 'text/plain' },
                      }),
                    );
                  }
                }
              } catch {
                // A lost race or a truncated body must not fail the load.
              }
            }
            return res;
          })
          .catch(() => null);

        const cached = await caches.match(SHELL_URL);
        if (cached) {
          const winner = await Promise.race([
            network,
            new Promise((resolve) => setTimeout(() => resolve(null), SHELL_TIMEOUT_MS)),
          ]);
          if (winner) return winner;
          // Serve what we have, but let the fetch finish so the cache is
          // current for the next launch rather than permanently stale.
          event.waitUntil(network);
          return cached;
        }

        try {
          const res = await network;
          if (res) return res;
          throw new Error('offline');
        } catch {
          // Offline with nothing cached. An honest page beats the browser's
          // dinosaur, because the fix here is "wake the Mac", not "get signal".
          // When a relay list was scraped from an earlier shell, offer the
          // backup addresses too: the primary may be down while a backup
          // answers, and an installed app launched into an outage has no
          // other way to learn the other addresses.
          let relayLinks = '';
          try {
            const saved = await caches.match(RELAY_LIST_KEY);
            const origins = ((await saved?.text()) || '')
              .split(/\s+/)
              .filter((o) => /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(o));
            if (origins.length) {
              relayLinks =
                '<p>Or try a backup address directly. Each address pairs ' +
                'separately, so an unpaired one asks for its pairing link first.</p><p>' +
                origins.map((o) => `<a href="${o}/app">${o}</a>`).join('<br>') +
                '</p>';
            }
          } catch {
            // No list, no links; the honest page below still stands.
          }
          return new Response(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
             <style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#f9f9f7;color:#2d2d2b;
             display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;text-align:center}
             div{max-width:22rem;padding:2rem}p{opacity:.7}a{color:#2d2d2b}</style>
             <div><h1>Can't reach your computer</h1>
             <p>Aside runs on your computer, so it needs to be awake and on the network.
             Check that Amphetamine is on if the lid is shut.</p>${relayLinks}</div>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' }, status: 503 },
          );
        }
      })(),
    );
  }
});

/*
 * Web Push: the reminder half of the app. These handlers are inert until
 * the page calls pushManager.subscribe, so they cost nothing in the
 * Telegram webview or a plain browser tab.
 *
 * A push message must show a notification promptly or the browser reports
 * the site as abusive, so the handler is deliberately dumb: parse, show,
 * done. Formatting and judgement live on the server (nextpush.ts), which
 * knows the plan.
 */
self.addEventListener('push', (event) => {
  let data = { t: '', b: '', tag: 'aside', url: '/app' };
  try {
    const parsed = event.data ? event.data.json() : null;
    if (parsed) data = { ...data, ...parsed };
  } catch {
    // Not JSON: still surface something rather than fail silently, because
    // a dropped push reads to the user as "the app forgot me".
    if (event.data) data.b = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.t || 'Aside', {
      body: data.b,
      tag: data.tag || 'aside',
      icon: '/icon-192.png',
      badge: '/aside-clay-192.png',
      data: { url: data.url || '/app' },
    }),
  );
});

/*
 * One tap, one motion, one destination. A push stores the item's deep
 * link (data.url, e.g. /app?item=schoology%3A123456). iOS complicates the
 * obvious "just open the URL" plan: a suspended home-screen app resumes
 * without loading any URL at all, so the destination is stashed in the
 * Cache API first, where the app can pick it up no matter how it wakes.
 * A live page also gets a postMessage for instant open, and the classic
 * navigate/focus/openWindow path covers everything else (and cold starts).
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    (async () => {
      // Stash for the iOS resume path: visible in window context via
      // caches.match(location.origin + '/__aside-pending').
      try {
        const cache = await caches.open('aside-open');
        await cache.put(
          new Request(`${self.location.origin}/__aside-pending`),
          new Response(url, { headers: { 'content-type': 'text/plain' } }),
        );
      } catch {
        /* best effort: the other paths still carry the url */
      }
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        try {
          c.postMessage({ type: 'aside-open', url });
        } catch {
          /* not listening yet */
        }
      }
      for (const c of all) {
        if ('navigate' in c) {
          try {
            await c.navigate(url);
          } catch {
            /* suspended iOS client or not controlled: focus is next */
          }
        }
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
