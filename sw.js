/*
 * Chrono — service worker.
 *
 * Stratégie « réseau d'abord », reprise de KeyMint et de la leçon payée sur la
 * PWA TDL : un cache-first restait collé à une vieille version sur iOS, et
 * aucun correctif n'arrivait jamais jusqu'à l'appareil. Ici le réseau gagne
 * dès qu'il répond ; le cache n'est qu'un filet pour le hors-ligne.
 *
 * Le numéro de version est injecté par tools/build_pwa.py.
 */
const VERSION = '57';
const CACHE = 'chrono-v' + VERSION;

// La liste est **produite par la construction** (`tools/build_pwa.py`), qui
// sait exactement ce qu'elle a copié. Tenue à la main, elle prenait du retard
// en silence : trois fichiers du suivi y manquaient, et une installation faite
// puis coupée du réseau aurait ouvert une application privée de ses
// statistiques, sans le moindre message.
const ASSETS = [
  "./",
  "./apple-touch-icon.png",
  "./badges/badge-01.png",
  "./badges/badge-02.png",
  "./badges/badge-03.png",
  "./badges/badge-04.png",
  "./badges/badge-05.png",
  "./badges/badge-06.png",
  "./badges/badge-07.png",
  "./badges/badge-08.png",
  "./badges/badge-09.png",
  "./badges/badge-10.png",
  "./brand.png",
  "./chrono.css",
  "./chrono.js",
  "./flip.css",
  "./fonts/Inter-Bold.ttf",
  "./fonts/Inter-SemiBold.ttf",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./index.html",
  "./manifest.webmanifest",
  "./suivi-ui.js",
  "./suivi.css",
  "./suivi.js",
  "./tableau.css",
  "./tableau.js",
  "./timer.js"
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/*
 * TOUJOURS REVALIDER CE QUI VIENT DE CHEZ NOUS.
 *
 * « Réseau d'abord » ne suffisait pas : le `fetch` d'un service worker passe
 * lui aussi par le cache HTTP du navigateur, et GitHub Pages sert ses pages
 * avec une durée de vie. Une application rouverte dix fois pouvait donc
 * continuer de recevoir un `index.html` périmé — qui réclame à son tour les
 * scripts sous leur ancien numéro de version, tous en cache. Le correctif
 * n'arrivait jamais, sans que rien ne le signale.
 *
 * `no-cache` ne désactive pas le cache : il le fait revalider auprès du
 * serveur. Une version inchangée coûte un « 304 » et rien de plus.
 *
 * Seules les requêtes de même origine sont réécrites. Reconstruire celles qui
 * partent vers Supabase leur ferait perdre leurs en-têtes — dont le secret de
 * synchronisation, sans lequel la base ne répond rien.
 */
function aRevalider(requete) {
  if (requete.url.indexOf(self.location.origin) !== 0) return requete;
  return new Request(requete.url, {
    cache: 'no-cache',
    credentials: requete.credentials,
    headers: requete.headers,
    mode: requete.mode === 'navigate' ? 'same-origin' : requete.mode,
    redirect: requete.redirect
  });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(aRevalider(e.request))
      .then((reponse) => {
        // On ne met en cache que ce qui est réellement servi : une réponse
        // d'erreur mise en cache se rejouerait hors ligne comme si de rien.
        if (reponse && reponse.ok) {
          const copie = reponse.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copie));
        }
        return reponse;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match('./index.html')))
  );
});
