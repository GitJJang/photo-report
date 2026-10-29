/* 오프라인 동작 + 공유 메뉴로 사진 받기 */
const VERSION = "sdj-v1.2.4";
const SHELL = ["./", "index.html", "app.js", "xlsm-core.js", "vendor/jszip.min.js", "template.xlsm", "data/stations.json", "data/parts.json", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  // 브라우저 HTTP 캐시(깃허브 10분)를 건너뛰고 서버에서 새로 받는다
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("sdj-v") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      try {
        const form = await req.formData(), files = form.getAll("photos").filter((f) => f && f.size);
        const cache = await caches.open("sdj-shared");
        for (const k of await cache.keys()) await cache.delete(k);
        let i = 0;
        for (const f of files) await cache.put(new Request(new URL("shared/" + Date.now() + "-" + i++, self.registration.scope).href), new Response(f, { headers: { "Content-Type": f.type || "image/jpeg", "X-Name": encodeURIComponent(f.name || "공유 사진.jpg"), "X-Time": String(f.lastModified || Date.now()) } }));
        return Response.redirect(new URL("./?shared=" + files.length, self.registration.scope).href, 303);
      } catch (err) { return Response.redirect(new URL("./", self.registration.scope).href, 303); }
    })());
    return;
  }
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // 화면·코드·목록은 인터넷이 되면 항상 최신(3초 안에 응답 없으면 저장본), 큰 파일은 저장본 먼저
  const fresh = req.mode === "navigate" || /\.(js|json|html|webmanifest)$/.test(url.pathname) || url.pathname.endsWith("/");
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req, { cache: "no-cache" }).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (!hit) return (await net) || new Response("오프라인이에요. 인터넷에 한 번 연결한 뒤 다시 열어 주세요.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    if (!fresh) { e.waitUntil(net); return hit; }
    const res = await Promise.race([net, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!res) e.waitUntil(net);
    return (res && res.ok) ? res : hit;
  })());
});
