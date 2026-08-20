// ══════════════════════════════════════════════════════════════════════════
//  AgroLease Tracker — Service Worker
//  Permite que la app abra y funcione sin señal en el campo.
//
//  Estrategia:
//   · App shell y librerías → cache-first (se sirven al instante, incluso offline).
//   · Tiles satelitales     → cache-first con tope, para que los lotes ya
//                             visitados se vean sin conexión.
//   · Firestore y Nominatim → SIEMPRE a la red (Firestore trae su propio
//                             caché offline vía enablePersistence()).
// ══════════════════════════════════════════════════════════════════════════

const VERSION     = 'v4';
const SHELL_CACHE = `agrolease-shell-${VERSION}`;
const TILE_CACHE  = `agrolease-tiles-${VERSION}`;
const MAX_TILES   = 800;   // ~40-60 MB de imágenes satelitales

const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css',
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js',
    'https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js',
    'https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js',
    'https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js'
];

// Dominios que nunca se cachean: necesitan datos frescos o manejan su propio offline.
const SIEMPRE_RED = [
    'firestore.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'nominatim.openstreetmap.org',
    'photon.komoot.io'
];

// ── Instalación: precargamos el shell ─────────────────────────────────────
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(SHELL_CACHE).then(async (cache) => {
            // Uno por uno para que un CDN caído no aborte toda la instalación.
            await Promise.all(APP_SHELL.map(url =>
                cache.add(new Request(url, { cache: 'reload' }))
                     .catch(err => console.warn('[SW] No se pudo cachear', url, err))
            ));
            self.skipWaiting();
        })
    );
});

// ── Activación: limpiamos versiones viejas ────────────────────────────────
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(names => Promise.all(
            names.filter(n => n.startsWith('agrolease-') && n !== SHELL_CACHE && n !== TILE_CACHE)
                 .map(n => caches.delete(n))
        )).then(() => self.clients.claim())
    );
});

// ── Al tocar la notificación de vencimientos, traemos la app al frente ────
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
            for (const c of lista) if ('focus' in c) return c.focus();
            if (self.clients.openWindow) return self.clients.openWindow('./index.html');
        })
    );
});

// ── Recorte del caché de tiles (evita que crezca sin límite) ──────────────
async function recortarTiles() {
    const cache = await caches.open(TILE_CACHE);
    const keys  = await cache.keys();
    if (keys.length <= MAX_TILES) return;
    // Borramos las más antiguas (las keys vienen en orden de inserción).
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map(k => cache.delete(k)));
}

// ── Interceptor de red ────────────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (SIEMPRE_RED.some(host => url.hostname.includes(host))) return;

    // Imágenes satelitales de Esri: cache-first con tope.
    if (url.hostname.includes('arcgisonline.com')) {
        e.respondWith(
            caches.open(TILE_CACHE).then(async (cache) => {
                const hit = await cache.match(req);
                if (hit) return hit;
                try {
                    const res = await fetch(req);
                    if (res.ok || res.type === 'opaque') {
                        cache.put(req, res.clone());
                        recortarTiles();
                    }
                    return res;
                } catch (err) {
                    // Sin señal y sin tile cacheado: devolvemos vacío para que
                    // Leaflet muestre el hueco en vez de romper el mapa.
                    return new Response('', { status: 504, statusText: 'Tile sin conexión' });
                }
            })
        );
        return;
    }

    // El HTML va network-first: así una versión recién publicada se ve al toque.
    // Si no hay señal, cae al índice cacheado y la app abre igual.
    if (req.mode === 'navigate' || req.destination === 'document') {
        e.respondWith(
            fetch(req).then(res => {
                if (res && res.ok) {
                    const copia = res.clone();
                    caches.open(SHELL_CACHE).then(c => c.put('./index.html', copia));
                }
                return res;
            }).catch(async () =>
                (await caches.match('./index.html')) ||
                (await caches.match('./'))           ||
                new Response('<h1>Sin conexión</h1><p>Abrí la app una vez con señal para poder usarla offline.</p>',
                             { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
            )
        );
        return;
    }

    // Librerías y estáticos (URLs versionadas, no cambian): cache-first.
    e.respondWith(
        caches.match(req).then(hit => {
            if (hit) return hit;
            return fetch(req).then(res => {
                if (res && res.ok && (url.origin === self.location.origin || APP_SHELL.includes(req.url))) {
                    const copia = res.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(req, copia));
                }
                return res;
            }).catch(() => new Response('', { status: 504, statusText: 'Sin conexión' }));
        })
    );
});
