/// <reference lib="webworker" />
/**
 * Service worker (injectManifest strategy).
 *
 * Responsibilities:
 *  - precache the application shell (including mtcute's WASM provider)
 *  - SPA navigation fallback
 *  - accept `POST /share-target` from the OS share sheet (Web Share Target),
 *    stash the shared files in CacheStorage, then redirect into the app
 */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const SHARE_CACHE = 'vault-share-target';
const SHARE_PATH = '/share-target';

interface SharedFileEntry {
  name: string;
  type: string;
  size: number;
  key: string;
}

interface SharedMeta {
  id: string;
  createdAt: number;
  title: string;
  text: string;
  files: SharedFileEntry[];
}

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.skipWaiting();
clientsClaim();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/share-target/, /^\/__share\//],
  }),
);

const absolute = (path: string): string => new URL(path, self.location.origin).toString();

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: absolute(path) } });
}

async function handleShare(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const files = form
      .getAll('media')
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (files.length === 0) return redirect('/?share=empty');

    const id = crypto.randomUUID();
    const base = `/__share/${id}/`;
    const cache = await caches.open(SHARE_CACHE);
    const entries: SharedFileEntry[] = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) continue;
      const key = `${base}file/${index}`;
      entries.push({
        name: file.name || `shared-${index}`,
        type: file.type || 'application/octet-stream',
        size: file.size,
        key: absolute(key),
      });
      await cache.put(
        absolute(key),
        new Response(file, {
          headers: { 'content-type': file.type || 'application/octet-stream' },
        }),
      );
    }

    const meta: SharedMeta = {
      id,
      createdAt: Date.now(),
      title: String(form.get('title') ?? ''),
      text: String(form.get('text') ?? ''),
      files: entries,
    };
    await cache.put(
      absolute(`${base}meta`),
      new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }),
    );

    return redirect(`/?share=${id}`);
  } catch {
    return redirect('/?share=error');
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === SHARE_PATH) {
    event.respondWith(handleShare(event.request));
  }
});
