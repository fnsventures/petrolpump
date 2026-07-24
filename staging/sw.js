const CACHE_VERSION="v124",STATIC_CACHE=`bpf-static-${CACHE_VERSION}`,DYNAMIC_CACHE=`bpf-dynamic-${CACHE_VERSION}`,API_CACHE=`bpf-api-${CACHE_VERSION}`,STATIC_ASSET_PATHS=["index.html","about.html","login.html","dashboard.html","dsr.html","meter-reading.html","expenses.html","credit.html","billing.html","reports.html","analysis.html","day-closing.html","attendance.html","salary.html","staff.html","settings.html","invoices.html","letterhead.html","sales-daily.html","credit-customer.html","credit-overdue.html","404.html","manifest.json","css/base.css","css/fonts.css","css/landing.css","css/login.css","css/app-core.css","css/app-dashboard.css","css/app-analysis.css","css/app-dsr.css","css/app-meter-reading.css","css/app-day-closing.css","css/app-credit.css","css/app-billing.css","css/app-reports.css","css/app-attendance.css","css/app-salary.css","css/app-staff.css","css/invoice-print.css","css/reports-print.css","css/salary-slip-print.css","css/credit-summary-print.css","css/staff-id-print.css","css/letterhead-print.css","css/app-letterhead.css","assets/favicon-32.png","assets/apple-touch-icon.png","assets/icon-192.png","assets/icon-512.png","assets/logo-44.webp","assets/logo-104.webp","assets/logo-print.webp","assets/landing-01.webp","assets/landing-01-800.webp","assets/landing-02.webp","assets/landing-02-800.webp","assets/landing-03.webp","assets/landing-03-800.webp","assets/landing-04.webp","assets/landing-04-800.webp","fonts/dm-sans-latin.woff2","fonts/dm-sans-latin-ext.woff2","fonts/dm-sans-italic-latin.woff2","fonts/dm-sans-italic-latin-ext.woff2","fonts/source-serif-4-latin.woff2","fonts/source-serif-4-latin-ext.woff2","fonts/caveat-latin.woff2","fonts/caveat-latin-ext.woff2","js/vendor/supabase-login.min.js","js/vendor/supabase.min.js","js/roleBootstrap.js","js/appNav.js","js/dsrSections.js","js/dsrLegacyRedirect.js","js/dsrFuelNav.js","js/errorHandler.js","js/cache.js","js/appConfig.js","js/utils.js","js/printUtils.js","js/pumpSettings.js","js/supabase.js","js/auth.js","js/pageSections.js","js/dateRangeFilter.js","js/dsrQueries.js","js/buyingPriceEntry.js","js/purchaseTaxUtils.js","js/staffEmployees.js","js/creditCustomerDetail.js","js/creditOverview.js","js/creditRecord.js","js/creditCustomer.js","js/dsrSummary.js","js/landing.js","js/dashboard.js","js/dsr.js","js/meterReading.js","js/expenses.js","js/credit.js","js/billing.js","js/reports.js","js/analysis.js","js/day-closing.js","js/attendance.js","js/salary.js","js/staff.js","js/settings.js","js/invoices.js","js/letterhead.js"],CACHE_MATCH_OPTS={ignoreSearch:!0};function getScopeBase(){const s=self.registration?.scope||new URL("./",self.location.href).href;return s.endsWith("/")?s:`${s}/`}function resolveScopedUrl(s){if(!s||s.startsWith("http"))return s;const t=String(s).replace(/^\//,"");return new URL(t,getScopeBase()).href}const API_PATTERNS=[/\/rest\/v1\//,/\/functions\/v1\//],CACHE_TTL={api:120*1e3,static:1440*60*1e3};self.addEventListener("install",s=>{console.log("[SW] Installing service worker..."),s.waitUntil(caches.open(STATIC_CACHE).then(t=>(console.log("[SW] Caching static assets..."),Promise.allSettled(STATIC_ASSET_PATHS.map(e=>t.add(resolveScopedUrl(e)).catch(a=>{console.warn(`[SW] Failed to cache: ${e}`,a)}))))).then(()=>(console.log("[SW] Static assets cached"),self.skipWaiting())).catch(t=>{console.error("[SW] Install failed:",t)}))}),self.addEventListener("activate",s=>{console.log("[SW] Activating service worker..."),s.waitUntil(caches.keys().then(t=>Promise.all(t.filter(e=>e.startsWith("bpf-")&&e!==STATIC_CACHE&&e!==DYNAMIC_CACHE&&e!==API_CACHE).map(e=>(console.log("[SW] Deleting old cache:",e),caches.delete(e))))).then(()=>(console.log("[SW] Service worker activated"),self.clients.claim())))}),self.addEventListener("fetch",s=>{const{request:t}=s,e=new URL(t.url);if(t.method==="GET"&&e.protocol.startsWith("http")){if(e.pathname.endsWith("/js/env.js")){s.respondWith(fetch(t));return}if(isApiRequest(e)&&isNoCacheApiRequest(e)){s.respondWith(fetch(t));return}if(isApiRequest(e)){s.respondWith(networkFirstStrategy(t,API_CACHE));return}if(isStaticAsset(e)){s.respondWith(cacheFirstStrategy(t,STATIC_CACHE));return}if(isHtmlPage(e)){s.respondWith(staleWhileRevalidate(t,DYNAMIC_CACHE));return}s.respondWith(networkWithCacheFallback(t,DYNAMIC_CACHE))}});function isApiRequest(s){return API_PATTERNS.some(t=>t.test(s.pathname))}function isNoCacheApiRequest(s){const t=s.pathname,e=s.searchParams?.get("table")??"";return!!(["credit_customers","credit_entries","credit_payments","employees","users","employee_attendance","salary_payments","salary_month_exclusions","dsr","dsr_petrol","dsr_diesel","expenses","day_closing","night_cash_collections","invoices","invoice_items","invoice_documents","pump_settings"].some(n=>t.includes(n)||e===n)||t.includes("/rpc/")||t.includes("/functions/v1/"))}function isStaticAsset(s){return[".css",".js",".png",".jpg",".jpeg",".gif",".svg",".ico",".woff",".woff2"].some(e=>s.pathname.endsWith(e))}function isHtmlPage(s){return s.pathname.endsWith(".html")||s.pathname==="/"||!s.pathname.includes(".")}function isApiCacheFresh(s){const t=s.headers.get("sw-cached-at");if(!t)return!0;const e=Date.now()-Number(t);return Number.isFinite(e)&&e<CACHE_TTL.api}async function putApiCacheEntry(s,t,e){const a=new Headers(e.headers);a.set("sw-cached-at",String(Date.now()));const n=await e.clone().blob(),i=new Response(n,{status:e.status,statusText:e.statusText,headers:a});await s.put(t,i)}async function networkFirstStrategy(s,t){try{const e=await fetch(s);if(e.ok){const a=await caches.open(t);await putApiCacheEntry(a,s,e)}return e}catch{console.log("[SW] Network failed, trying cache:",s.url);const a=await caches.match(s,CACHE_MATCH_OPTS);return a&&isApiCacheFresh(a)?a:new Response(JSON.stringify({error:"offline",message:"You are offline. Please check your connection."}),{status:503,statusText:"Service Unavailable",headers:{"Content-Type":"application/json"}})}}async function cacheFirstStrategy(s,t){const e=await caches.match(s,CACHE_MATCH_OPTS);if(e)return refreshCacheInBackground(s,t),e;try{const a=await fetch(s);return a.ok&&(await caches.open(t)).put(s,a.clone()),a}catch(a){return console.error("[SW] Cache-first failed:",s.url,a),new Response("Resource not available offline",{status:503})}}async function staleWhileRevalidate(s,t){const e=await caches.open(t),a=await e.match(s,CACHE_MATCH_OPTS),n=fetch(s).then(c=>(c.ok&&e.put(s,c.clone()),c)).catch(c=>(console.warn("[SW] Background fetch failed:",s.url,c),null));if(a)return a;const i=await n;return i||getOfflineFallback()}async function networkWithCacheFallback(s,t){try{const e=await fetch(s);return e.ok&&(await caches.open(t)).put(s,e.clone()),e}catch{const a=await caches.match(s,CACHE_MATCH_OPTS);return a||getOfflineFallback()}}function refreshCacheInBackground(s,t){fetch(s).then(async e=>{e.ok&&(await caches.open(t)).put(s,e)}).catch(()=>{})}async function getOfflineFallback(){const s=await caches.match(resolveScopedUrl("index.html"),CACHE_MATCH_OPTS);return s||new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Offline - Bishnupriya Fuels</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f5f5;
      color: #333;
    }
    .offline-container {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
    .offline-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }
    p {
      color: #666;
      margin-bottom: 1.5rem;
    }
    button {
      background: #0070c0;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 1rem;
    }
    button:hover {
      background: #005a9c;
    }
  </style>
</head>
<body>
  <div class="offline-container">
    <div class="offline-icon">\u{1F4E1}</div>
    <h1>You're Offline</h1>
    <p>Please check your internet connection and try again.</p>
    <button onclick="window.location.reload()">Try Again</button>
  </div>
</body>
</html>`,{status:503,statusText:"Service Unavailable",headers:{"Content-Type":"text/html"}})}self.addEventListener("message",s=>{const{type:t,payload:e}=s.data||{};switch(t){case"SKIP_WAITING":self.skipWaiting();break;case"CLEAR_CACHE":clearAllCaches().then(()=>{s.ports[0]?.postMessage({success:!0})});break;case"CLEAR_API_CACHE":caches.delete(API_CACHE).then(()=>{s.ports[0]?.postMessage({success:!0})});break;case"GET_CACHE_STATS":getCacheStats().then(a=>{s.ports[0]?.postMessage(a)});break;case"INVALIDATE_PATTERN":e?.pattern&&invalidateCacheByPattern(e.pattern).then(()=>{s.ports[0]?.postMessage({success:!0})});break}});async function clearAllCaches(){const s=await caches.keys();await Promise.all(s.filter(t=>t.startsWith("bpf-")).map(t=>caches.delete(t)))}async function getCacheStats(){const s={static:{entries:0},dynamic:{entries:0},api:{entries:0}};try{const e=await(await caches.open(STATIC_CACHE)).keys();s.static.entries=e.length;const n=await(await caches.open(DYNAMIC_CACHE)).keys();s.dynamic.entries=n.length;const c=await(await caches.open(API_CACHE)).keys();s.api.entries=c.length}catch{}return s}async function invalidateCacheByPattern(s){const t=new RegExp(s),e=await caches.keys();for(const a of e){if(!a.startsWith("bpf-"))continue;const n=await caches.open(a),i=await n.keys();for(const c of i)t.test(c.url)&&await n.delete(c)}}console.log("[SW] Service worker script loaded");
