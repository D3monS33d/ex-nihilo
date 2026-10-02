// Service worker with one job: add the two response headers that make the page
// "cross-origin isolated", which is what browsers require before they allow shared
// memory between threads. Static hosts such as GitHub Pages cannot set these headers
// themselves. Nothing is cached; every request goes to the network as usual.
//
// Without this (or if service workers are unavailable) the simulation still works. It
// just copies data between threads instead of sharing it, and runs two to three times
// slower while the universe is sterile.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response; // opaque: cannot be re-wrapped
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
