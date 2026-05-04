const CACHE_NAME = 'animesao-vX17';
const CACHE_NAME_IMAGES = 'animesao-img-vX17';

// Versioned/static assets — cache-first (fingerprinted by ?v= query)
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css?v=X15',
    '/script.js?v=X12',
    '/auth.js?v=X4',
    '/info-table.js?v=X2',
    '/login-inicio.png',
    '/manifest.json',
    '/icon-96.png',
    '/icon-144.png',
    '/icon-192.png',
    '/icon-384.png',
    '/icon-512.png',
    '/icon-maskable-192.png',
    '/icon-maskable-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url)));
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys
                .filter(key => key !== CACHE_NAME && key !== CACHE_NAME_IMAGES)
                .map(key => caches.delete(key))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);

    // Never intercept API calls
    if (url.pathname.startsWith('/api/')) return;

    // Cache-first for icons and fonts (immutable content)
    if (
        url.pathname.match(/\.(png|ico|webp|woff2?|ttf)$/) ||
        url.hostname === 'fonts.gstatic.com'
    ) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    if (response && response.status === 200) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME_IMAGES).then(cache => cache.put(event.request, copy));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // Stale-while-revalidate for HTML/CSS/JS — instant load + background refresh
    event.respondWith(
        caches.open(CACHE_NAME).then(cache => {
            return cache.match(event.request).then(cached => {
                const fetchPromise = fetch(event.request).then(response => {
                    if (response && response.status === 200) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                }).catch(() => cached);
                return cached || fetchPromise;
            });
        })
    );
});
