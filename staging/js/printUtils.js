(function(mt){const z="position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none",ut="position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none",f="print-utils-host",dt=`
#${f} {
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
  /* Keep watermark (body child) visible alongside the print host \u2014 same
     page-box fixed positioning as desktop iframe print. */
  body > *:not(#${f}):not(.report-watermark--page) {
    display: none !important;
  }
  #${f} {
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
`;function P(t){return new URL(t,window.location.href).href}const B="logo-44|logo-80|logo-104|logo-print|bpcl-logo|bishnupriya-fuels-logo",ft="invoice-bpcl-logo|report-bpcl-logo|salary-slip-logo",yt=".report-bpcl-logo, .invoice-bpcl-logo, .salary-slip-logo, .report-watermark-img";function S(){const t=typeof AppConfig<"u"&&AppConfig.getStationLogoPrintSrc?.()||"assets/logo-print.webp";return P(t)}const C=100,k="46%",F="0.08",A=384;function wt(){return`
body > .report-watermark,
html body .report-watermark.report-watermark--page{
  position:fixed!important;
  top:0!important;
  left:0!important;
  right:0!important;
  bottom:0!important;
  width:100%!important;
  height:100%!important;
  margin:0!important;
  padding:0!important;
  inset:unset!important;
  display:flex!important;
  align-items:center!important;
  justify-content:center!important;
  overflow:hidden!important;
  pointer-events:none!important;
  z-index:1000!important;
  -webkit-print-color-adjust:exact!important;
  print-color-adjust:exact!important;
}
body > .report-watermark .report-watermark-img,
html body .report-watermark.report-watermark--page .report-watermark-img{
  display:block!important;
  width:${C}mm!important;
  height:${C}mm!important;
  max-width:${k}!important;
  max-height:${k}!important;
  object-fit:contain!important;
  opacity:${F}!important;
  margin:0!important;
  -webkit-print-color-adjust:exact!important;
  print-color-adjust:exact!important;
}`}function ht(t){t.style.setProperty("position","fixed","important"),t.style.setProperty("top","0","important"),t.style.setProperty("left","0","important"),t.style.setProperty("right","0","important"),t.style.setProperty("bottom","0","important"),t.style.setProperty("width","100%","important"),t.style.setProperty("height","100%","important"),t.style.setProperty("margin","0","important"),t.style.setProperty("padding","0","important"),t.style.setProperty("display","flex","important"),t.style.setProperty("align-items","center","important"),t.style.setProperty("justify-content","center","important"),t.style.setProperty("pointer-events","none","important"),t.style.setProperty("z-index","1000","important"),t.style.setProperty("-webkit-print-color-adjust","exact","important"),t.style.setProperty("print-color-adjust","exact","important")}function gt(t){t.style.setProperty("display","block","important"),t.style.setProperty("width",`${C}mm`,"important"),t.style.setProperty("height",`${C}mm`,"important"),t.style.setProperty("max-width",k,"important"),t.style.setProperty("max-height",k,"important"),t.style.setProperty("object-fit","contain","important"),t.style.setProperty("opacity",F,"important"),t.style.setProperty("margin","0","important"),t.style.setProperty("-webkit-print-color-adjust","exact","important"),t.style.setProperty("print-color-adjust","exact","important")}function K(t={}){const e=S();if(t.fixed)return"";const r="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:0;margin:0;padding:0;overflow:hidden;",n=`width:min(46%,15rem);height:auto;max-height:min(46%,15rem);object-fit:contain;opacity:${F};margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;`;return`<div class="report-watermark" aria-hidden="true" style="${r}"><img src="${e}" alt="" class="report-watermark-img" width="${A}" height="${A}" decoding="async" style="${n}" /></div>`}const Pt=/<(div|article)(\s[^>]*\bclass\s*=\s*["'][^"']*\b(?:report-print-sheet|e20-sheet)\b[^"']*["'][^>]*)>/i;function bt(t,e={}){const r=String(t||"");if(e.fixed||!r||r.includes('class="report-watermark"')||r.includes("class='report-watermark'")||r.includes('class="report-watermark-layer"'))return r;const n=K(e),i=r.replace(Pt,`${n}<$1$2>`);return i===r?`${n}${r}`:i}function q(t,e){const r=t||"",n=e||"";return r.includes("report-print-body")||r.includes("e20-print-body")||n.includes("report-print-container")}function G(t,e,r){if(!q(e,r))return String(t||"");const n=String(t||"").replace(/<div class="report-watermark-layer"[^>]*>[\s\S]*?<\/div>/gi,"").replace(/<div class="report-watermark"[^>]*>[\s\S]*?<\/div>/gi,"");return`<style>${wt()}</style>${n}`}function Y(t){if(!t?.body)return;t.querySelectorAll(".report-watermark-layer, .report-watermark").forEach(n=>n.remove());const e=t.createElement("div");e.className="report-watermark report-watermark--page",e.setAttribute("aria-hidden","true"),ht(e);const r=t.createElement("img");r.className="report-watermark-img",r.alt="",r.width=A,r.height=A,r.decoding="sync",r.src=S(),gt(r),e.appendChild(r),t.body.appendChild(e)}async function X(t,e,r){q(e,r)&&(Y(t),await W(t,".report-watermark-img",3e3),await x(t))}function St(t){const e=S();return String(t||"").replace(new RegExp(`<picture>[\\s\\S]*?<img([^>]*class="[^"]*(?:${ft})[^"]*"[^>]*)>[\\s\\S]*?<\\/picture>`,"gi"),`<img$1 src="${e}" width="128" height="128" />`).replace(new RegExp(`src="[^"]*(?:${B})[^"]*"`,"gi"),`src="${e}"`).replace(new RegExp(`srcset="[^"]*(?:${B})[^"]*"`,"gi"),"")}function M(t){return String(t||"").replace(/<\/style/gi,"<\\/style")}function V(t,e=48){const r=Number.isFinite(e)&&e>0?e:48;return String(t??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[\/\\]+/g,"-").replace(/[^\p{L}\p{N}\s._-]+/gu,"").trim().replace(/[\s._]+/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"").slice(0,r).replace(/-+$/g,"").toLowerCase()}function $t(...t){return t.flat().map(r=>V(r)).filter(Boolean).join("-").replace(/-+/g,"-").replace(/^-+|-+$/g,"")||"document"}function y(t){return typeof escapeHtml=="function"?escapeHtml(t):String(t??"")}function Z(t,e){const r=typeof PumpSettings<"u"&&PumpSettings.getStationGstin?.()||"",n=typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||"",i=typeof PumpSettings<"u"&&PumpSettings.getStationTagline?.()||"",a=(e||[]).filter(Boolean).map(o=>`<p class="report-subtitle">${o}</p>`).join("");return`
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${S()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${y(n)}</h1>
          <p class="report-dealer">${y(i)}</p>
          ${r?`<p class="report-gstin">GSTIN: ${y(r)}</p>`:""}
          <p class="report-title">${y(t)}</p>
          ${a}
        </div>
      </div>
    </header>`}function J(t,e){const r=typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||"";return`
    <footer class="report-print-foot">
      <span>${y(r)}</span>
      <span>${y(t)}${e?` \xB7 ${y(e)}`:""}</span>
    </footer>`}function Rt(t,e,r,n){return`
    <div class="report-print-sheet">
      ${Z(t,e)}
      ${r}
      ${J(t,n)}
    </div>`}const O="css/reports-print.css?v=16",Q="css/credit-summary-print.css?v=7",tt=/@import\s+(?:url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)|['"]([^'"]+)['"])\s*[^;]*;/gi;let $=null,R=null,_=null,E=null,u=null;function Et(t){return new Promise((e,r)=>{const n=document.createElement("link");n.rel="stylesheet",n.href=t;const i=window.setTimeout(()=>{n.remove(),r(new Error("Timed out loading print styles."))},8e3);n.onload=()=>{window.clearTimeout(i);let a="";try{a=[...n.sheet.cssRules].map(o=>o.cssText).join(`
`)}catch{n.remove(),r(new Error("Could not read print styles."));return}n.remove(),$=a,e(a)},n.onerror=()=>{window.clearTimeout(i),n.remove(),r(new Error("Could not load report print styles."))},document.head.appendChild(n)})}async function j(){return $||R||(R=(async()=>{try{try{return $=await H(O),$}catch{return Et(P(O))}}finally{R=null}})(),R)}function et(){j().catch(()=>{})}async function N(){return _||E||(E=(async()=>{try{const[t,e]=await Promise.all([j(),fetch(P(Q),{cache:"default"})]);if(!e.ok)throw new Error("Could not load credit summary print styles.");const r=(await e.text()).replace(tt,"");return _=`${t}
${r}`,_}finally{E=null}})(),E)}function Tt(){et(),N().catch(()=>{})}function rt(){typeof u=="function"&&(u(),u=null)}let T;function nt(){if(typeof T=="boolean")return T;if(typeof navigator>"u")return T=!1,!1;const t=navigator.userAgent||"";return T=/Android/i.test(t)||/iPhone|iPad|iPod/i.test(t)||navigator.platform==="MacIntel"&&(navigator.maxTouchPoints||0)>1,T}function xt(t){return String(t||"").replace(/(^|[,{\s>+~])html(\s*,\s*body)?(?=[\s,{>:#[.]|$)/g,(e,r)=>`${r}#${f}`).replace(/(^|[,{\s>+~])body(\.[\w-]+)?(?=[\s,{>:#[.]|$)/g,(e,r,n)=>`${r}#${f}${n||""}`)}async function it(t,e=5e3){await new Promise(r=>{const n=window.setTimeout(r,e),i=()=>{window.clearTimeout(n),r()};t.document.readyState==="complete"?i():t.addEventListener("load",i,{once:!0})})}async function W(t,e,r=2500){const a=(Array.isArray(e)?e:[e]).flatMap(o=>Array.from(t.querySelectorAll(o))).filter(o=>o&&!o.complete);a.length&&await Promise.race([Promise.all(a.map(o=>new Promise(s=>{o.addEventListener("load",s,{once:!0}),o.addEventListener("error",s,{once:!0})}))),new Promise(o=>window.setTimeout(o,r))])}async function x(t){await new Promise(e=>requestAnimationFrame(()=>requestAnimationFrame(e))),t?.body&&t.body.offsetHeight}function vt(t){const e=Array.from(t?.styleSheets||[]);if(!e.length)return!0;for(const r of e)try{const n=r.cssRules;for(const i of n)if(i.type===CSSRule.IMPORT_RULE)try{i.styleSheet?.cssRules}catch{return!1}}catch{return!1}return!0}async function L(t,e=4e3){if(!t)return;const r=Array.from(t.querySelectorAll('link[rel="stylesheet"]'));r.length&&await Promise.all(r.map(i=>st(i,e)));const n=Date.now()+e;for(;Date.now()<n&&!vt(t);)await new Promise(i=>window.setTimeout(i,40))}async function D(t,e,r={}){const{imageSelectors:n=[],waitForLoad:i=!0,timeoutMs:a=2500}=r;i&&e&&await it(e),await L(t,Math.max(a,4e3)),n.length&&await W(t,n,a),await x(t)}function ot(t){const{title:e="Print",bodyHtml:r="",cssHref:n,cssText:i,headExtras:a="",bodyClass:o="",containerClass:s=""}=t,l=typeof escapeHtml=="function"?escapeHtml(e):e,d=i?`<style>${M(i)}</style>`:n?`<link rel="stylesheet" href="${P(n)}" />`:"",w=o?` class="${o}"`:"",h=s?`<div class="${s}">${r}</div>`:r;return`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${l}</title>
  ${d}
  ${a}
</head>
<body${w}>
  ${h}
</body>
</html>`}function at(){document.querySelectorAll("[data-print-utils]").forEach(t=>t.remove()),document.getElementById(f)?.remove(),document.querySelectorAll("body > .report-watermark--page, body > .report-watermark").forEach(t=>t.remove())}async function st(t,e=2e3){await Promise.race([new Promise(r=>{t.addEventListener("load",r,{once:!0}),t.addEventListener("error",r,{once:!0})}),new Promise(r=>window.setTimeout(r,e))])}async function Ct(t,{printOnly:e=!1}={}){if(!t)return;const r=document.createElement("template");r.innerHTML=String(t).trim();const n=[];for(const i of Array.from(r.content.children))i.setAttribute("data-print-utils","extra"),e&&i.tagName==="LINK"&&i.getAttribute("rel")==="stylesheet"&&!i.getAttribute("media")&&i.setAttribute("media","print"),i.tagName==="LINK"&&i.getAttribute("rel")==="stylesheet"&&n.push(st(i)),document.head.appendChild(i);n.length&&await Promise.all(n)}async function H(t,e=new Set){const r=P(t);if(e.has(r))return"";e.add(r);const n=await fetch(r,{cache:"default"});if(!n.ok)throw new Error("Could not load print stylesheet.");let i=await n.text();const a=[];let o;const s=new RegExp(tt.source,"gi");for(;(o=s.exec(i))!==null;)a.push({full:o[0],path:o[1]||o[2]});for(const l of a){const d=new URL(l.path,r).href,w=await H(d,e);i=i.replace(l.full,w)}return i}async function lt(t,e){return t?String(t):e?String(e).includes("credit-summary-print")?N():H(e):""}async function ct(t){const e={...t};return e.cssText||!e.cssHref||(e.cssText=await lt(null,e.cssHref),e.cssHref=void 0),e}async function kt(t){rt();const e=await ct(t),{title:r="Print",bodyHtml:n="",cssHref:i,cssText:a,headExtras:o="",bodyClass:s="",containerClass:l="",waitForReady:d,cleanupTimeoutMs:w=5e3}=e,h=G(n,s,l);at();const U=document.title;document.title=r;const b=document.createElement("style");b.setAttribute("data-print-utils","shell"),b.textContent=dt,document.head.appendChild(b);const I=await lt(a,i);if(I){const g=document.createElement("style");g.setAttribute("data-print-utils","css"),g.textContent=`@media print {
${M(xt(I))}
}`,document.head.appendChild(g)}await Ct(o,{printOnly:!0});const c=document.createElement("div");c.id=f,s&&(c.className=s),c.setAttribute("aria-hidden","true"),c.innerHTML=l?`<div class="${l}">${h}</div>`:h,document.body.appendChild(c);let p=!1;const m=()=>{p||(p=!0,at(),document.title=U)};try{return u=m,typeof d=="function"?(await d(document,window),await L(document),await x(document)):await D(document,window,{...e,waitForLoad:!1}),await X(document,s,l),window.addEventListener("afterprint",m,{once:!0}),window.focus(),window.print(),window.setTimeout(m,w),!0}catch(g){throw m(),g}finally{u===m&&(u=null)}}async function At(t){if(nt())return kt(t);rt();const e=await ct(t),{title:r="Print",bodyHtml:n="",cssHref:i,cssText:a,headExtras:o="",bodyClass:s="",containerClass:l="",iframeTitle:d="Print",iframeStyle:w=z,waitForReady:h,cleanupTimeoutMs:U=5e3,onFallback:b}=e,I=G(n,s,l),c=document.createElement("iframe");c.setAttribute("title",d),c.style.cssText=w,document.body.appendChild(c);const p=c.contentDocument,m=c.contentWindow;if(!p||!m){if(c.remove(),typeof b=="function")return b(),!1;throw new Error("Print frame unavailable")}p.open(),p.write(ot({title:r,bodyHtml:I,cssHref:i,cssText:a,headExtras:o,bodyClass:s,containerClass:l})),p.close();const g=document.title;document.title=r;let pt=!1;const v=()=>{pt||(pt=!0,c.remove(),document.title=g)};try{return u=v,typeof h=="function"?(await h(p,m),await L(p),await x(p)):await D(p,m,e),await X(p,s,l),m.addEventListener("afterprint",v,{once:!0}),m.focus(),m.print(),window.setTimeout(v,U),!0}catch(_t){throw v(),_t}finally{u===v&&(u=null)}}mt.PrintUtils={COMPACT_IFRAME_STYLE:ut,CREDIT_SUMMARY_PRINT_CSS_HREF:Q,DEFAULT_IFRAME_STYLE:z,PRINT_LOGO_IMAGE_SELECTORS:yt,REPORT_PRINT_CSS_HREF:O,applyPrintLogos:St,buildPrintDocumentHtml:ot,buildPrintFilename:$t,buildReportLetterhead:Z,buildReportPrintFooter:J,buildReportWatermarkHtml:K,ensureReportWatermark:bt,escapeInlineCss:M,getCreditSummaryPrintCssText:N,getReportPrintCssText:j,getStationLogoPrintUrl:S,iframePrintUnreliable:nt,layoutPrintWatermarks:Y,preloadCreditSummaryPrintCss:Tt,preloadReportPrintCss:et,printInIframe:At,resolveAssetUrl:P,resolveCssHrefWithImports:H,sanitizeFilenamePart:V,waitForDocumentStylesheets:L,waitForFrameLoad:it,waitForImages:W,waitForPaint:x,waitForPrintReady:D,wrapReportPrintSheet:Rt}})(typeof window<"u"?window:globalThis);
