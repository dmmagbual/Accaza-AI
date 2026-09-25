/* Accaza AI service worker: network first, cached shell as the offline fallback. */
const CACHE='accaza-ai-v5';
const ASSETS=['/','/index.html','/manifest.webmanifest','/favicon.ico','/favicon_32x32.png','/favicon_180x180.png','/favicon_192x192.png','/favicon_512x512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.all(ASSETS.map(a=>c.add(a).catch(()=>null)))));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/__/'))return;
  e.respondWith(fetch(e.request).then(r=>{if(r&&r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});}return r;})
    .catch(()=>caches.match(e.request).then(hit=>hit||(e.request.mode==='navigate'?caches.match('/index.html'):undefined))));
});
