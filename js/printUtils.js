(function(et){const N="position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none",nt="position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none",m="print-utils-host",rt=`
#${m} {
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
  body > *:not(#${m}) {
    display: none !important;
  }
  #${m} {
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
`;function g(t){return new URL(t,window.location.href).href}const O="logo-44|logo-80|logo-104|logo-print|bpcl-logo|bishnupriya-fuels-logo",it="invoice-bpcl-logo|report-bpcl-logo|salary-slip-logo",ot=".report-bpcl-logo, .invoice-bpcl-logo, .salary-slip-logo";function L(){const t=typeof AppConfig<"u"&&AppConfig.getStationLogoPrintSrc?.()||"assets/logo-print.webp";return g(t)}function st(t){const e=L();return String(t||"").replace(new RegExp(`<picture>[\\s\\S]*?<img([^>]*class="[^"]*(?:${it})[^"]*"[^>]*)>[\\s\\S]*?<\\/picture>`,"gi"),`<img$1 src="${e}" width="128" height="128" />`).replace(new RegExp(`src="[^"]*(?:${O})[^"]*"`,"gi"),`src="${e}"`).replace(new RegExp(`srcset="[^"]*(?:${O})[^"]*"`,"gi"),"")}function _(t){return String(t||"").replace(/<\/style/gi,"<\\/style")}function M(t,e=48){const n=Number.isFinite(e)&&e>0?e:48;return String(t??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[\/\\]+/g,"-").replace(/[^\p{L}\p{N}\s._-]+/gu,"").trim().replace(/[\s._]+/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"").slice(0,n).replace(/-+$/g,"").toLowerCase()}function at(...t){return t.flat().map(n=>M(n)).filter(Boolean).join("-").replace(/-+/g,"-").replace(/^-+|-+$/g,"")||"document"}function w(t){return typeof escapeHtml=="function"?escapeHtml(t):String(t??"")}function k(t,e){const n=typeof PumpSettings<"u"&&PumpSettings.getStationGstin?.()||"",r=typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||"",i=typeof PumpSettings<"u"&&PumpSettings.getStationTagline?.()||"",s=(e||[]).filter(Boolean).map(o=>`<p class="report-subtitle">${o}</p>`).join("");return`
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${L()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${w(r)}</h1>
          <p class="report-dealer">${w(i)}</p>
          ${n?`<p class="report-gstin">GSTIN: ${w(n)}</p>`:""}
          <p class="report-title">${w(t)}</p>
          ${s}
        </div>
      </div>
    </header>`}function D(t,e){const n=typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||"";return`
    <footer class="report-print-foot">
      <span>${w(n)}</span>
      <span>${w(t)}${e?` \xB7 ${w(e)}`:""}</span>
    </footer>`}function lt(t,e,n,r){return`
    <div class="report-print-sheet">
      ${k(t,e)}
      ${n}
      ${D(t,r)}
    </div>`}const U="css/reports-print.css?v=8",j="css/credit-summary-print.css?v=3",G=/@import\s+(?:url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)|['"]([^'"]+)['"])\s*[^;]*;/gi;let S=null,C=null,R=null,b=null,d=null;function ct(t){return new Promise((e,n)=>{const r=document.createElement("link");r.rel="stylesheet",r.href=t;const i=window.setTimeout(()=>{r.remove(),n(new Error("Timed out loading print styles."))},8e3);r.onload=()=>{window.clearTimeout(i);let s="";try{s=[...r.sheet.cssRules].map(o=>o.cssText).join(`
`)}catch{r.remove(),n(new Error("Could not read print styles."));return}r.remove(),S=s,e(s)},r.onerror=()=>{window.clearTimeout(i),r.remove(),n(new Error("Could not load report print styles."))},document.head.appendChild(r)})}async function I(){if(S)return S;if(C)return C;const t=g(U);return C=(async()=>{try{const e=await fetch(t,{cache:"default"});return e.ok?(S=await e.text(),S):ct(t)}finally{C=null}})(),C}function q(){I().catch(()=>{})}async function F(){return R||b||(b=(async()=>{try{const[t,e]=await Promise.all([I(),fetch(g(j),{cache:"default"})]);if(!e.ok)throw new Error("Could not load credit summary print styles.");const n=(await e.text()).replace(G,"");return R=`${t}
${n}`,R}finally{b=null}})(),b)}function ut(){q(),F().catch(()=>{})}function B(){typeof d=="function"&&(d(),d=null)}let T;function z(){if(typeof T=="boolean")return T;if(typeof navigator>"u")return T=!1,!1;const t=navigator.userAgent||"";return T=/Android/i.test(t)||/iPhone|iPad|iPod/i.test(t)||navigator.platform==="MacIntel"&&(navigator.maxTouchPoints||0)>1,T}function dt(t){return String(t||"").replace(/(^|[,{\s>+~])html(\s*,\s*body)?(?=[\s,{>:#[.]|$)/g,(e,n)=>`${n}#${m}`).replace(/(^|[,{\s>+~])body(\.[\w-]+)?(?=[\s,{>:#[.]|$)/g,(e,n,r)=>`${n}#${m}${r||""}`)}async function Y(t,e=5e3){await new Promise(n=>{const r=window.setTimeout(n,e),i=()=>{window.clearTimeout(r),n()};t.document.readyState==="complete"?i():t.addEventListener("load",i,{once:!0})})}async function K(t,e,n=2500){const s=(Array.isArray(e)?e:[e]).flatMap(o=>Array.from(t.querySelectorAll(o))).filter(o=>o&&!o.complete);s.length&&await Promise.race([Promise.all(s.map(o=>new Promise(l=>{o.addEventListener("load",l,{once:!0}),o.addEventListener("error",l,{once:!0})}))),new Promise(o=>window.setTimeout(o,n))])}async function x(t){await new Promise(e=>requestAnimationFrame(()=>requestAnimationFrame(e))),t?.body&&t.body.offsetHeight}function pt(t){const e=Array.from(t?.styleSheets||[]);if(!e.length)return!0;for(const n of e)try{const r=n.cssRules;for(const i of r)if(i.type===CSSRule.IMPORT_RULE)try{i.styleSheet?.cssRules}catch{return!1}}catch{return!1}return!0}async function A(t,e=4e3){if(!t)return;const n=Array.from(t.querySelectorAll('link[rel="stylesheet"]'));n.length&&await Promise.all(n.map(i=>J(i,e)));const r=Date.now()+e;for(;Date.now()<r&&!pt(t);)await new Promise(i=>window.setTimeout(i,40))}async function H(t,e,n={}){const{imageSelectors:r=[],waitForLoad:i=!0,timeoutMs:s=2500}=n;i&&e&&await Y(e),await A(t,Math.max(s,4e3)),r.length&&await K(t,r,s),await x(t)}function W(t){const{title:e="Print",bodyHtml:n="",cssHref:r,cssText:i,headExtras:s="",bodyClass:o="",containerClass:l=""}=t,p=typeof escapeHtml=="function"?escapeHtml(e):e,f=i?`<style>${_(i)}</style>`:r?`<link rel="stylesheet" href="${g(r)}" />`:"",h=o?` class="${o}"`:"",P=l?`<div class="${l}">${n}</div>`:n;return`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${p}</title>
  ${f}
  ${s}
</head>
<body${h}>
  ${P}
</body>
</html>`}function V(){document.querySelectorAll("[data-print-utils]").forEach(t=>t.remove()),document.getElementById(m)?.remove()}async function J(t,e=2e3){await Promise.race([new Promise(n=>{t.addEventListener("load",n,{once:!0}),t.addEventListener("error",n,{once:!0})}),new Promise(n=>window.setTimeout(n,e))])}async function ft(t,{printOnly:e=!1}={}){if(!t)return;const n=document.createElement("template");n.innerHTML=String(t).trim();const r=[];for(const i of Array.from(n.content.children))i.setAttribute("data-print-utils","extra"),e&&i.tagName==="LINK"&&i.getAttribute("rel")==="stylesheet"&&!i.getAttribute("media")&&i.setAttribute("media","print"),i.tagName==="LINK"&&i.getAttribute("rel")==="stylesheet"&&r.push(J(i)),document.head.appendChild(i);r.length&&await Promise.all(r)}async function Q(t,e=new Set){const n=g(t);if(e.has(n))return"";e.add(n);const r=await fetch(n,{cache:"default"});if(!r.ok)throw new Error("Could not load print stylesheet.");let i=await r.text();const s=[];let o;const l=new RegExp(G.source,"gi");for(;(o=l.exec(i))!==null;)s.push({full:o[0],path:o[1]||o[2]});for(const p of s){const f=new URL(p.path,n).href,h=await Q(f,e);i=i.replace(p.full,h)}return i}async function X(t,e){return t?String(t):e?String(e).includes("credit-summary-print")?F():Q(e):""}async function Z(t){const e={...t};return e.cssText||!e.cssHref||(e.cssText=await X(null,e.cssHref),e.cssHref=void 0),e}async function mt(t){B();const e=await Z(t),{title:n="Print",bodyHtml:r="",cssHref:i,cssText:s,headExtras:o="",bodyClass:l="",containerClass:p="",waitForReady:f,cleanupTimeoutMs:h=5e3}=e;V();const P=document.title;document.title=n;const $=document.createElement("style");$.setAttribute("data-print-utils","shell"),$.textContent=rt,document.head.appendChild($);const E=await X(s,i);if(E){const y=document.createElement("style");y.setAttribute("data-print-utils","css"),y.textContent=`@media print {
${_(dt(E))}
}`,document.head.appendChild(y)}await ft(o,{printOnly:!0});const a=document.createElement("div");a.id=m,l&&(a.className=l),a.setAttribute("aria-hidden","true"),a.innerHTML=p?`<div class="${p}">${r}</div>`:r,document.body.appendChild(a);let u=!1;const c=()=>{u||(u=!0,V(),document.title=P)};try{return d=c,typeof f=="function"?(await f(document,window),await A(document),await x(document)):await H(document,window,{...e,waitForLoad:!1}),window.addEventListener("afterprint",c,{once:!0}),window.focus(),window.print(),window.setTimeout(c,h),!0}catch(y){throw c(),y}finally{d===c&&(d=null)}}async function wt(t){if(z())return mt(t);B();const e=await Z(t),{title:n="Print",bodyHtml:r="",cssHref:i,cssText:s,headExtras:o="",bodyClass:l="",containerClass:p="",iframeTitle:f="Print",iframeStyle:h=N,waitForReady:P,cleanupTimeoutMs:$=5e3,onFallback:E}=e,a=document.createElement("iframe");a.setAttribute("title",f),a.style.cssText=h,document.body.appendChild(a);const u=a.contentDocument,c=a.contentWindow;if(!u||!c){if(a.remove(),typeof E=="function")return E(),!1;throw new Error("Print frame unavailable")}u.open(),u.write(W({title:n,bodyHtml:r,cssHref:i,cssText:s,headExtras:o,bodyClass:l,containerClass:p})),u.close();const y=document.title;document.title=n;let tt=!1;const v=()=>{tt||(tt=!0,a.remove(),document.title=y)};try{return d=v,typeof P=="function"?(await P(u,c),await A(u),await x(u)):await H(u,c,e),c.addEventListener("afterprint",v,{once:!0}),c.focus(),c.print(),window.setTimeout(v,$),!0}catch(ht){throw v(),ht}finally{d===v&&(d=null)}}et.PrintUtils={COMPACT_IFRAME_STYLE:nt,CREDIT_SUMMARY_PRINT_CSS_HREF:j,DEFAULT_IFRAME_STYLE:N,PRINT_LOGO_IMAGE_SELECTORS:ot,REPORT_PRINT_CSS_HREF:U,applyPrintLogos:st,buildPrintDocumentHtml:W,buildPrintFilename:at,buildReportLetterhead:k,buildReportPrintFooter:D,escapeInlineCss:_,getCreditSummaryPrintCssText:F,getReportPrintCssText:I,getStationLogoPrintUrl:L,iframePrintUnreliable:z,preloadCreditSummaryPrintCss:ut,preloadReportPrintCss:q,printInIframe:wt,resolveAssetUrl:g,sanitizeFilenamePart:M,waitForDocumentStylesheets:A,waitForFrameLoad:Y,waitForImages:K,waitForPaint:x,waitForPrintReady:H,wrapReportPrintSheet:lt}})(typeof window<"u"?window:globalThis);
