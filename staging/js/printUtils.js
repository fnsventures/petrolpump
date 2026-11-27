"use strict";(function(dt){const K="position:fixed;left:-9999px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none",ft="position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none",f="print-utils-host",yt=`
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
`;function S(t){return new URL(t,window.location.href).href}const q="logo-44|logo-80|logo-104|logo-print|bpcl-logo|bishnupriya-fuels-logo",ht="invoice-bpcl-logo|report-bpcl-logo|salary-slip-logo",wt=".report-bpcl-logo, .invoice-bpcl-logo, .salary-slip-logo, .report-watermark-img";function P(){const t=typeof AppConfig<"u"&&AppConfig.getStationLogoPrintSrc?.()||"assets/logo-print.webp";return S(t)}const x=100,k="46%",z="0.08",A=384;function gt(){return`
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
  width:${x}mm!important;
  height:${x}mm!important;
  max-width:${k}!important;
  max-height:${k}!important;
  object-fit:contain!important;
  opacity:${z}!important;
  margin:0!important;
  -webkit-print-color-adjust:exact!important;
  print-color-adjust:exact!important;
}`}function St(t){t.style.setProperty("position","fixed","important"),t.style.setProperty("top","0","important"),t.style.setProperty("left","0","important"),t.style.setProperty("right","0","important"),t.style.setProperty("bottom","0","important"),t.style.setProperty("width","100%","important"),t.style.setProperty("height","100%","important"),t.style.setProperty("margin","0","important"),t.style.setProperty("padding","0","important"),t.style.setProperty("display","flex","important"),t.style.setProperty("align-items","center","important"),t.style.setProperty("justify-content","center","important"),t.style.setProperty("pointer-events","none","important"),t.style.setProperty("z-index","1000","important"),t.style.setProperty("-webkit-print-color-adjust","exact","important"),t.style.setProperty("print-color-adjust","exact","important")}function Pt(t){t.style.setProperty("display","block","important"),t.style.setProperty("width",`${x}mm`,"important"),t.style.setProperty("height",`${x}mm`,"important"),t.style.setProperty("max-width",k,"important"),t.style.setProperty("max-height",k,"important"),t.style.setProperty("object-fit","contain","important"),t.style.setProperty("opacity",z,"important"),t.style.setProperty("margin","0","important"),t.style.setProperty("-webkit-print-color-adjust","exact","important"),t.style.setProperty("print-color-adjust","exact","important")}function G(t={}){const e=P();return t.fixed?"":`<div class="report-watermark" aria-hidden="true"><img src="${e}" alt="" class="report-watermark-img" width="${A}" height="${A}" decoding="async" /></div>`}const bt=/<(div|article)(\s[^>]*\bclass\s*=\s*["'][^"']*\b(?:report-print-sheet|e20-sheet)\b[^"']*["'][^>]*)>/i;function Rt(t,e={}){const r=String(t||"");if(e.fixed||!r||r.includes('class="report-watermark"')||r.includes("class='report-watermark'")||r.includes('class="report-watermark-layer"'))return r;const n=G(e),o=r.replace(bt,`${n}<$1$2>`);return o===r?`${n}${r}`:o}function M(t,e){const r=t||"",n=e||"";return r.includes("report-print-body")||r.includes("e20-print-body")||n.includes("report-print-container")}function Y(t,e,r){return M(e,r)?String(t||"").replace(/<div class="report-watermark-layer"[^>]*>[\s\S]*?<\/div>/gi,"").replace(/<div class="report-watermark"[^>]*>[\s\S]*?<\/div>/gi,""):String(t||"")}function V(t,e,r){const n=[];return t&&n.push(String(t)),M(e,r)&&n.push(gt()),n}function X(t){if(!t?.body)return;t.querySelectorAll(".report-watermark-layer, .report-watermark").forEach(n=>n.remove());const e=t.createElement("div");e.className="report-watermark report-watermark--page",e.setAttribute("aria-hidden","true"),St(e);const r=t.createElement("img");r.className="report-watermark-img",r.alt="",r.width=A,r.height=A,r.decoding="sync",r.src=P(),Pt(r),e.appendChild(r),t.body.appendChild(e)}async function Z(t,e,r){M(e,r)&&(X(t),await D(t,".report-watermark-img",3e3),await $(t))}function Tt(t,e=P()){return String(t||"").replace(new RegExp(`<picture>[\\s\\S]*?<img([^>]*class="[^"]*(?:${ht})[^"]*"[^>]*)>[\\s\\S]*?<\\/picture>`,"gi"),`<img$1 src="${e}" width="128" height="128" />`).replace(new RegExp(`src="[^"]*(?:${q})[^"]*"`,"gi"),`src="${e}"`).replace(new RegExp(`srcset="[^"]*(?:${q})[^"]*"`,"gi"),"")}function Et(t){const e=t?.defaultView;return!!(e&&"adoptedStyleSheets"in t&&typeof e.CSSStyleSheet=="function"&&typeof e.CSSStyleSheet.prototype.replaceSync=="function")}function $t(t,e){const r=(e||[]).filter(Boolean);if(!r.length)return[];if(!Et(t))throw new Error("This browser is too old to print from the app. Update the browser and try again.");const n=t.defaultView.CSSStyleSheet;return r.map(o=>{const a=new n;return a.replaceSync(String(o).replace(new RegExp(N.source,"gi"),"")),a})}function J(t,e){const r=$t(t,e);return r.length&&(t.adoptedStyleSheets=[...t.adoptedStyleSheets,...r]),r}function Q(t,e=48){const r=Number.isFinite(e)&&e>0?e:48;return String(t??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[\/\\]+/g,"-").replace(/[^\p{L}\p{N}\s._-]+/gu,"").trim().replace(/[\s._]+/g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"").slice(0,r).replace(/-+$/g,"").toLowerCase()}function Ct(...t){return t.flat().map(r=>Q(r)).filter(Boolean).join("-").replace(/-+/g,"-").replace(/^-+|-+$/g,"")||"document"}function y(t){return escapeHtml(t)}function tt(t,e){const r=typeof PumpSettings<"u"&&PumpSettings.getStationGstin?.()||"",n=typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||"",o=typeof PumpSettings<"u"&&PumpSettings.getStationTagline?.()||"",a=(e||[]).filter(Boolean).map(i=>`<p class="report-subtitle">${i}</p>`).join("");return`
    <header class="report-print-head">
      <div class="report-letterhead">
        <img src="${P()}" alt="Bishnupriya Fuels" class="station-logo report-bpcl-logo" width="128" height="128" />
        <div class="report-letterhead-text">
          <h1 class="report-station">${y(n)}</h1>
          <p class="report-dealer">${y(o)}</p>
          ${r?`<p class="report-gstin">GSTIN: ${y(r)}</p>`:""}
          <p class="report-title">${y(t)}</p>
          ${a}
        </div>
      </div>
    </header>`}function et(t,e){const r=typeof PumpSettings<"u"&&PumpSettings.getStationLegalName?.()||"";return`
    <footer class="report-print-foot">
      <span>${y(r)}</span>
      <span>${y(t)}${e?` \xB7 ${y(e)}`:""}</span>
    </footer>`}function vt(t,e,r,n){return`
    <div class="report-print-sheet">
      ${tt(t,e)}
      ${r}
      ${et(t,n)}
    </div>`}const O="css/reports-print.css?v=1be63fc8c3",rt="css/credit-summary-print.css?v=d881414f5a",N=/@import\s+(?:url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)|['"]([^'"]+)['"])\s*[^;]*;/gi;let b=null,R=null,_=null,T=null,m=null;function xt(t){return new Promise((e,r)=>{const n=document.createElement("link");n.rel="stylesheet",n.href=t;const o=window.setTimeout(()=>{n.remove(),r(new Error("Timed out loading print styles."))},8e3);n.onload=()=>{window.clearTimeout(o);let a="";try{const i=s=>[...s.cssRules].map(l=>l.type===CSSRule.IMPORT_RULE&&l.styleSheet?i(l.styleSheet):l.cssText).join(`
`);a=i(n.sheet)}catch{n.remove(),r(new Error("Could not read print styles."));return}n.remove(),b=a,e(a)},n.onerror=()=>{window.clearTimeout(o),n.remove(),r(new Error("Could not load report print styles."))},document.head.appendChild(n)})}async function j(){return b||R||(R=(async()=>{try{try{return b=await I(O),b}catch{return xt(S(O))}}finally{R=null}})(),R)}function nt(){j().catch(()=>{})}async function W(){return _||T||(T=(async()=>{try{const[t,e]=await Promise.all([j(),fetch(S(rt),{cache:"default"})]);if(!e.ok)throw new Error("Could not load credit summary print styles.");const r=(await e.text()).replace(N,"");return _=`${t}
${r}`,_}finally{T=null}})(),T)}function kt(){nt(),W().catch(()=>{})}function ot(){typeof m=="function"&&(m(),m=null)}let E;function it(){if(typeof E=="boolean")return E;if(typeof navigator>"u")return E=!1,!1;const t=navigator.userAgent||"";return E=/Android/i.test(t)||/iPhone|iPad|iPod/i.test(t)||navigator.platform==="MacIntel"&&(navigator.maxTouchPoints||0)>1,E}function At(t){return String(t||"").replace(/(^|[,{\s>+~])html(\s*,\s*body)?(?=[\s,{>:#[.]|$)/g,(e,r)=>`${r}#${f}`).replace(/(^|[,{\s>+~])body(\.[\w-]+)?(?=[\s,{>:#[.]|$)/g,(e,r,n)=>`${r}#${f}${n||""}`)}async function at(t,e=5e3){await new Promise(r=>{const n=window.setTimeout(r,e),o=()=>{window.clearTimeout(n),r()};t.document.readyState==="complete"?o():t.addEventListener("load",o,{once:!0})})}async function D(t,e,r=2500){const a=(Array.isArray(e)?e:[e]).flatMap(i=>Array.from(t.querySelectorAll(i))).filter(i=>i&&!i.complete);a.length&&await Promise.race([Promise.all(a.map(i=>new Promise(s=>{i.addEventListener("load",s,{once:!0}),i.addEventListener("error",s,{once:!0})}))),new Promise(i=>window.setTimeout(i,r))])}async function $(t){await new Promise(e=>requestAnimationFrame(()=>requestAnimationFrame(e))),t?.body&&t.body.offsetHeight}function _t(t){const e=Array.from(t?.styleSheets||[]);if(!e.length)return!0;for(const r of e)try{const n=r.cssRules;for(const o of n)if(o.type===CSSRule.IMPORT_RULE)try{o.styleSheet?.cssRules}catch{return!1}}catch{return!1}return!0}async function L(t,e=4e3){if(!t)return;const r=Array.from(t.querySelectorAll('link[rel="stylesheet"]'));r.length&&await Promise.all(r.map(o=>ct(o,e)));const n=Date.now()+e;for(;Date.now()<n&&!_t(t);)await new Promise(o=>window.setTimeout(o,40))}async function U(t,e,r={}){const{imageSelectors:n=[],waitForLoad:o=!0,timeoutMs:a=2500}=r;o&&e&&await at(e),await L(t,Math.max(a,4e3)),n.length&&await D(t,n,a),await $(t)}function st(t){const{title:e="Print",bodyHtml:r="",cssHref:n,cssText:o,headExtras:a="",bodyClass:i="",containerClass:s=""}=t,l=escapeHtml(e),d=!o&&n?`<link rel="stylesheet" href="${S(n)}" />`:"",h=i?` class="${i}"`:"",w=s?`<div class="${s}">${r}</div>`:r;return`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${l}</title>
  ${d}
  ${a}
</head>
<body${h}>
  ${w}
</body>
</html>`}let H=[];function Lt(){if(!H.length)return;const t=new Set(H);H=[],document.adoptedStyleSheets=document.adoptedStyleSheets.filter(e=>!t.has(e))}function lt(){Lt(),document.querySelectorAll("[data-print-utils]").forEach(t=>t.remove()),document.getElementById(f)?.remove(),document.querySelectorAll("body > .report-watermark--page, body > .report-watermark").forEach(t=>t.remove())}async function ct(t,e=2e3){await Promise.race([new Promise(r=>{t.addEventListener("load",r,{once:!0}),t.addEventListener("error",r,{once:!0})}),new Promise(r=>window.setTimeout(r,e))])}async function Ht(t,{printOnly:e=!1}={}){if(!t)return;const r=document.createElement("template");r.innerHTML=String(t).trim();const n=[];for(const o of Array.from(r.content.children))o.setAttribute("data-print-utils","extra"),e&&o.tagName==="LINK"&&o.getAttribute("rel")==="stylesheet"&&!o.getAttribute("media")&&o.setAttribute("media","print"),o.tagName==="LINK"&&o.getAttribute("rel")==="stylesheet"&&n.push(ct(o)),document.head.appendChild(o);n.length&&await Promise.all(n)}async function I(t,e=new Set){const r=S(t);if(e.has(r))return"";e.add(r);const n=await fetch(r,{cache:"default"});if(!n.ok)throw new Error("Could not load print stylesheet.");let o=await n.text();const a=[];let i;const s=new RegExp(N.source,"gi");for(;(i=s.exec(o))!==null;)a.push({full:i[0],path:i[1]||i[2]});for(const l of a){const d=new URL(l.path,r).href,h=await I(d,e);o=o.replace(l.full,h)}return o}async function pt(t,e){return t?String(t):e?String(e).includes("credit-summary-print")?W():I(e):""}async function ut(t){const e={...t};return e.cssText||!e.cssHref||(e.cssText=await pt(null,e.cssHref),e.cssHref=void 0),e}async function It(t){ot();const e=await ut(t),{title:r="Print",bodyHtml:n="",cssHref:o,cssText:a,headExtras:i="",bodyClass:s="",containerClass:l="",waitForReady:d,cleanupTimeoutMs:h=5e3}=e,w=Y(n,s,l);lt();const F=document.title;document.title=r;const C=await pt(a,o);try{H=J(document,[yt,...V(C?`@media print {
${At(C)}
}`:"",s,l)])}catch(u){throw document.title=F,u}await Ht(i,{printOnly:!0});const g=document.createElement("div");g.id=f,s&&(g.className=s),g.setAttribute("aria-hidden","true"),g.innerHTML=l?`<div class="${l}">${w}</div>`:w,document.body.appendChild(g);let p=!1;const c=()=>{p||(p=!0,lt(),document.title=F)};try{return m=c,typeof d=="function"?(await d(document,window),await L(document),await $(document)):await U(document,window,{...e,waitForLoad:!1}),await Z(document,s,l),window.addEventListener("afterprint",c,{once:!0}),window.focus(),window.print(),window.setTimeout(c,h),!0}catch(u){throw c(),u}finally{m===c&&(m=null)}}async function Ft(t){if(it())return It(t);ot();const e=await ut(t),{title:r="Print",bodyHtml:n="",cssHref:o,cssText:a,headExtras:i="",bodyClass:s="",containerClass:l="",iframeTitle:d="Print",iframeStyle:h=K,waitForReady:w,cleanupTimeoutMs:F=5e3,onFallback:C}=e,g=Y(n,s,l),p=document.createElement("iframe");p.setAttribute("title",d),p.style.cssText=h,document.body.appendChild(p);const c=p.contentDocument,u=p.contentWindow;if(!c||!u){if(p.remove(),typeof C=="function")return C(),!1;throw new Error("Print frame unavailable")}c.open(),c.write(st({title:r,bodyHtml:g,cssHref:o,cssText:a,headExtras:i,bodyClass:s,containerClass:l})),c.close();try{J(c,V(a,s,l))}catch(B){throw p.remove(),B}const Mt=document.title;document.title=r;let mt=!1;const v=()=>{mt||(mt=!0,p.remove(),document.title=Mt)};try{return m=v,typeof w=="function"?(await w(c,u),await L(c),await $(c)):await U(c,u,e),await Z(c,s,l),u.addEventListener("afterprint",v,{once:!0}),u.focus(),u.print(),window.setTimeout(v,F),!0}catch(B){throw v(),B}finally{m===v&&(m=null)}}dt.PrintUtils={COMPACT_IFRAME_STYLE:ft,CREDIT_SUMMARY_PRINT_CSS_HREF:rt,DEFAULT_IFRAME_STYLE:K,PRINT_LOGO_IMAGE_SELECTORS:wt,REPORT_PRINT_CSS_HREF:O,applyPrintLogos:Tt,buildPrintDocumentHtml:st,buildPrintFilename:Ct,buildReportLetterhead:tt,buildReportPrintFooter:et,buildReportWatermarkHtml:G,ensureReportWatermark:Rt,getCreditSummaryPrintCssText:W,getReportPrintCssText:j,getStationLogoPrintUrl:P,iframePrintUnreliable:it,layoutPrintWatermarks:X,preloadCreditSummaryPrintCss:kt,preloadReportPrintCss:nt,printInIframe:Ft,resolveAssetUrl:S,resolveCssHrefWithImports:I,sanitizeFilenamePart:Q,waitForDocumentStylesheets:L,waitForFrameLoad:at,waitForImages:D,waitForPaint:$,waitForPrintReady:U,wrapReportPrintSheet:vt}})(typeof window<"u"?window:globalThis);
