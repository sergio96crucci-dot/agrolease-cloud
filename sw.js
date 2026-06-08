self.addEventListener('install', (e) => {
    console.log('[Service Worker] Instalado correctamente');
});

self.addEventListener('fetch', (e) => {
    // Esto se deja vacío a propósito para que no interfiera con Firebase
    return;
});
