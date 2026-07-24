(function(j){const A="position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none",G="position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none",d="print-utils-host",B=`
#${d} {
  position: fixed;
  left: 0;
  top: 0;
  width: 210mm;
  max-width: 100%;
  margin: 0;
  padding: 0;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
  background: #fff;
}
@media print {
  body > *:not(#${d}) {
    display: none !important;
  }
  #${d} {
    display: block !important;
    position: static !important;
    left: auto !important;
    top: auto !important;
    width: 100% !important;
    max-width: none !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    z-index: auto !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}
`;function h(t){return new URL(t,window.location.href).href}const L="logo-44|logo-80|logo-104|logo-print|bpcl-logo|bishnupriya-fuels-logo",q="invoice-bpcl-logo|report-bpcl-logo|salary-slip-logo",z=".report-bpcl-logo, .invoice-bpcl-logo, .salary-slip-logo";function T(){const t=typeof AppConfig<"u"&&AppConfig.getStationLogoPrintSrc?.()||"assets/logo-print.webp";return h(t)}function K(t){const e=T();return String(t||"").replace(new RegExp(`<picture>[\\s\\S]*?<img([^>]*class="[^"]*(?:${q})[^"]*"[^>]*)>[\\s\\S]*?<\\/picture>`,"gi"),`<img$1 src="${e}" width="128" height="128" />`).replace(new RegExp(`src="[^"]*(?:${L})[^"]*"`,"gi"),`src="${e}"`).replace(new RegExp(`srcset="[^"]*(?:${L})[^"]*"`,"gi"),"")}function v(t){return String(t||"").replace(/<\/style/gi,"<\\/style")}function R(t,e=48){const n=Number.isFinite(e)&&e>0?e:48;return String(t??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[\/\\]+/g,"-").replace(/[^\p{L}\p{N}\s._-]+/gu,"").trim().replace(/[\s._]+/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"").slice(0,n).replace(/-+$/g,"").toLowerCase()}function Y(...t){return t.flat().map(n=>R(n)).filter(Boolean).join("-").replace(/-+/g,"-").replace(/^-+|-+$/g,"")||"document"}function p(t){return typeof escapeHtml=="function"?escapeHtml(t):String(t??"")}function x(t,e){const n=typeof PumpSettings<"u"&&PumpSettings.getStationGstin?.()||"",i=typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||"",o=typeof PumpSettings<"u"&&PumpSettings.getStationTagline?.()||"",a=(e||[]).filter(Boolean).map(r=>`<p class="report-subtitle">${r}</p>`).join("");return`
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${T()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${p(i)}</h1>
          <p class="report-dealer">${p(o)}</p>
          ${n?`<p class="report-gstin">GSTIN: ${p(n)}</p>`:""}
          <p class="report-title">${p(t)}</p>
          ${a}
        </div>
      </div>
    </header>`}function _(t,e){const n=typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||"";return`
    <footer class="report-print-foot">
      <span>${p(n)}</span>
      <span>${p(t)}${e?` \xB7 ${p(e)}`:""}</span>
    </footer>`}function V(t,e,n,i){return`
    <div class="report-print-sheet">
      ${x(t,e)}
      ${n}
      ${_(t,i)}
    </div>`}const F="css/reports-print.css?v=7";let y=null,P=null;function W(t){return new Promise((e,n)=>{const i=document.createElement("link");i.rel="stylesheet",i.href=t;const o=window.setTimeout(()=>{i.remove(),n(new Error("Timed out loading print styles."))},8e3);i.onload=()=>{window.clearTimeout(o);let a="";try{a=[...i.sheet.cssRules].map(r=>r.cssText).join(`
`)}catch{i.remove(),n(new Error("Could not read print styles."));return}i.remove(),y=a,e(a)},i.onerror=()=>{window.clearTimeout(o),i.remove(),n(new Error("Could not load report print styles."))},document.head.appendChild(i)})}async function H(){if(y)return y;if(P)return P;const t=h(F);return P=(async()=>{try{const e=await fetch(t,{cache:"default"});return e.ok?(y=await e.text(),y):W(t)}finally{P=null}})(),P}function J(){H().catch(()=>{})}let b;function I(){if(typeof b=="boolean")return b;if(typeof navigator>"u")return b=!1,!1;const t=navigator.userAgent||"";return b=/Android/i.test(t)||/iPhone|iPad|iPod/i.test(t)||navigator.platform==="MacIntel"&&(navigator.maxTouchPoints||0)>1,b}function Q(t){return String(t||"").replace(/(^|[,{\s>+~])html(\s*,\s*body)?(?=[\s,{>:#[.]|$)/g,(e,n)=>`${n}#${d}`).replace(/(^|[,{\s>+~])body(\.[\w-]+)?(?=[\s,{>:#[.]|$)/g,(e,n,i)=>`${n}#${d}${i||""}`)}async function N(t,e=5e3){await new Promise(n=>{const i=window.setTimeout(n,e),o=()=>{window.clearTimeout(i),n()};t.document.readyState==="complete"?o():t.addEventListener("load",o,{once:!0})})}async function O(t,e,n=2500){const a=(Array.isArray(e)?e:[e]).flatMap(r=>Array.from(t.querySelectorAll(r))).filter(r=>r&&!r.complete);a.length&&await Promise.race([Promise.all(a.map(r=>new Promise(l=>{r.addEventListener("load",l,{once:!0}),r.addEventListener("error",l,{once:!0})}))),new Promise(r=>window.setTimeout(r,n))])}async function M(t){await new Promise(e=>requestAnimationFrame(()=>requestAnimationFrame(e))),t?.body&&t.body.offsetHeight}async function E(t,e,n={}){const{imageSelectors:i=[],waitForLoad:o=!0,timeoutMs:a=2500}=n;o&&e&&await N(e),i.length&&await O(t,i,a),await M(t)}function k(t){const{title:e="Print",bodyHtml:n="",cssHref:i,cssText:o,headExtras:a="",bodyClass:r="",containerClass:l=""}=t,g=typeof escapeHtml=="function"?escapeHtml(e):e,S=o?`<style>${v(o)}</style>`:i?`<link rel="stylesheet" href="${h(i)}" />`:"",w=r?` class="${r}"`:"",m=l?`<div class="${l}">${n}</div>`:n;return`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${g}</title>
  ${S}
  ${a}
</head>
<body${w}>
  ${m}
</body>
</html>`}function U(){document.querySelectorAll("[data-print-utils]").forEach(t=>t.remove()),document.getElementById(d)?.remove()}async function X(t,e=2e3){await Promise.race([new Promise(n=>{t.addEventListener("load",n,{once:!0}),t.addEventListener("error",n,{once:!0})}),new Promise(n=>window.setTimeout(n,e))])}async function Z(t,{printOnly:e=!1}={}){if(!t)return;const n=document.createElement("template");n.innerHTML=String(t).trim();const i=[];for(const o of Array.from(n.content.children))o.setAttribute("data-print-utils","extra"),e&&o.tagName==="LINK"&&o.getAttribute("rel")==="stylesheet"&&!o.getAttribute("media")&&o.setAttribute("media","print"),o.tagName==="LINK"&&o.getAttribute("rel")==="stylesheet"&&i.push(X(o)),document.head.appendChild(o);i.length&&await Promise.all(i)}async function tt(t,e){if(t)return String(t);if(!e)return"";const n=await fetch(h(e),{cache:"default"});if(!n.ok)throw new Error("Could not load print stylesheet.");return await n.text()}async function et(t){const{title:e="Print",bodyHtml:n="",cssHref:i,cssText:o,headExtras:a="",bodyClass:r="",containerClass:l="",waitForReady:g,cleanupTimeoutMs:S=5e3}=t;U();const w=document.title;document.title=e;const m=document.createElement("style");m.setAttribute("data-print-utils","shell"),m.textContent=B,document.head.appendChild(m);const $=await tt(o,i);if($){const f=document.createElement("style");f.setAttribute("data-print-utils","css"),f.textContent=`@media print {
${v(Q($))}
}`,document.head.appendChild(f)}await Z(a,{printOnly:!0});const s=document.createElement("div");s.id=d,r&&(s.className=r),s.setAttribute("aria-hidden","true"),s.innerHTML=l?`<div class="${l}">${n}</div>`:n,document.body.appendChild(s);let u=!1;const c=()=>{u||(u=!0,U(),document.title=w)};try{return typeof g=="function"?await g(document,window):await E(document,window,{...t,waitForLoad:!1}),window.addEventListener("afterprint",c,{once:!0}),window.focus(),window.print(),window.setTimeout(c,S),!0}catch(f){throw c(),f}}async function nt(t){if(I())return et(t);const{title:e="Print",bodyHtml:n="",cssHref:i,cssText:o,headExtras:a="",bodyClass:r="",containerClass:l="",iframeTitle:g="Print",iframeStyle:S=A,waitForReady:w,cleanupTimeoutMs:m=5e3,onFallback:$}=t,s=document.createElement("iframe");s.setAttribute("title",g),s.style.cssText=S,document.body.appendChild(s);const u=s.contentDocument,c=s.contentWindow;if(!u||!c){if(s.remove(),typeof $=="function")return $(),!1;throw new Error("Print frame unavailable")}u.open(),u.write(k({title:e,bodyHtml:n,cssHref:i,cssText:o,headExtras:a,bodyClass:r,containerClass:l})),u.close();const f=document.title;document.title=e;let D=!1;const C=()=>{D||(D=!0,s.remove(),document.title=f)};try{return typeof w=="function"?await w(u,c):await E(u,c,t),c.addEventListener("afterprint",C,{once:!0}),c.focus(),c.print(),window.setTimeout(C,m),!0}catch(it){throw C(),it}}j.PrintUtils={COMPACT_IFRAME_STYLE:G,DEFAULT_IFRAME_STYLE:A,PRINT_LOGO_IMAGE_SELECTORS:z,REPORT_PRINT_CSS_HREF:F,applyPrintLogos:K,buildPrintDocumentHtml:k,buildPrintFilename:Y,buildReportLetterhead:x,buildReportPrintFooter:_,escapeInlineCss:v,getReportPrintCssText:H,getStationLogoPrintUrl:T,iframePrintUnreliable:I,preloadReportPrintCss:J,printInIframe:nt,resolveAssetUrl:h,sanitizeFilenamePart:R,waitForFrameLoad:N,waitForImages:O,waitForPaint:M,waitForPrintReady:E,wrapReportPrintSheet:V}})(typeof window<"u"?window:globalThis);
