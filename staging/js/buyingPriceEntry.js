"use strict";(function(j){async function A(e,t){const l=String(e||"").trim();if(!l)return null;const r=u=>{let p=window.supabaseClient.from("invoice_documents").select("id").eq("category","purchase").eq("title",l).order("invoice_date",{ascending:!1}).limit(1);return u&&t&&(p=p.eq("invoice_date",t)),p};let{data:a,error:n}=await r(!0);if(!n&&a?.[0]?.id||t&&({data:a,error:n}=await r(!1),!n&&a?.[0]?.id))return a[0].id;const o=`%${l.replace(/[%_\\]/g,"\\$&")}%`;let s=window.supabaseClient.from("invoice_documents").select("id, title").eq("category","purchase").ilike("title",o).order("invoice_date",{ascending:!1}).limit(10);t&&(s=s.eq("invoice_date",t));const i=await s;if(i.error||!i.data?.length)return t?A(l,null):null;const c=l.toLowerCase(),d=i.data.find(u=>String(u.title||"").trim().toLowerCase()===c);return d?d.id:i.data.find(u=>String(u.title||"").toLowerCase().includes(c))?.id??null}function R(e,t){e&&(e.textContent=t,e.classList.remove("hidden"))}function T(e){e?.classList.add("hidden")}function K(e){e?.querySelectorAll(".pl-field-invalid").forEach(t=>t.classList.remove("pl-field-invalid")),e?.querySelectorAll(".pl-block-error").forEach(t=>{t.textContent="",t.classList.add("hidden")})}function b(e){e?.classList.add("pl-field-invalid")}function m(e,t,l,r){const{errorEl:a}=e||{};R(a,l);const n=t?.querySelector(".pl-block-error");if(n&&(n.textContent=l,n.classList.remove("hidden")),r&&typeof r.focus=="function"){const o=r.closest?.("details");o&&(o.open=!0);try{r.focus({preventScroll:!1})}catch{r.focus()}r.scrollIntoView?.({block:"center",behavior:"smooth"})}else(n||a)?.scrollIntoView?.({block:"nearest",behavior:"smooth"})}function B(e,t={}){const{excludeDsrId:l,excludeLfrDate:r}=t,a={products:{},lfrByDate:{}};return e?.querySelectorAll(".pl-day-card").forEach(n=>{const o=n.dataset.date;o&&o!==r&&(a.lfrByDate[o]={total:n.querySelector(".pl-lfr-total")?.value??"",qty:n.querySelector(".pl-lfr-qty")?.value??""}),n.querySelectorAll(".pl-product-block").forEach(s=>{const i=s.dataset.dsrId;!i||i===l||(a.products[i]={rate:s.querySelector(".pl-buying-input")?.value??"",delTotal:s.querySelector(".pl-del-total")?.value??"",delQty:s.querySelector(".pl-del-qty")?.value??"",inv:s.querySelector(".pl-inv-input")?.value??"",gstin:s.querySelector(".pl-gstin-input")?.value??""})})}),a}function W(e,t){!e||!t||(Object.entries(t.lfrByDate||{}).forEach(([l,r])=>{const a=e.querySelector(`.pl-day-card[data-date="${CSS.escape?.(l)??l}"]`);if(!a)return;const n=a.querySelector(".pl-lfr-total"),o=a.querySelector(".pl-lfr-qty");n&&r.total!=null&&(n.value=r.total),o&&r.qty!=null&&(o.value=r.qty)}),Object.entries(t.products||{}).forEach(([l,r])=>{const a=CSS.escape?CSS.escape(l):l,n=e.querySelector(`.pl-product-block[data-dsr-id="${a}"]`);if(!n)return;const o=(s,i)=>{const c=n.querySelector(s);c&&i!=null&&(c.value=i)};o(".pl-buying-input",r.rate),o(".pl-del-total",r.delTotal),o(".pl-del-qty",r.delQty),o(".pl-inv-input",r.inv),o(".pl-gstin-input",r.gstin)}),e.querySelectorAll(".pl-day-card").forEach(l=>F(l)))}const I=new Map;function Y(e){const{listEl:t,countEl:l}=e||{},r=t?.querySelectorAll(".pl-day-card").length??0;l&&(l.textContent=r===1?"1 day pending":`${r} days pending`,l.classList.toggle("hidden",r===0)),P(e)}function P(e){const{listEl:t,toggleAllEl:l}=e||{};if(!l)return;const r=[...t?.querySelectorAll(".pl-day")??[]];l.classList.toggle("hidden",r.length<2);const a=r.length>0&&r.every(n=>n.open);l.textContent=a?"Collapse all":"Expand all",l.setAttribute("aria-expanded",String(a))}function Z(e){const{listEl:t,toggleAllEl:l}=e||{};!l||l.dataset.bound||(l.dataset.bound="1",l.addEventListener("click",()=>{const r=l.getAttribute("aria-expanded")!=="true";t?.querySelectorAll(".pl-day").forEach(a=>{a.open=r}),P(e)}))}function G(e){return Number(e.buying_price_per_litre)>0&&e.purchase_delivery_per_kl!=null}function k(e){return e.length>0&&e.every(t=>t.purchase_lfr_per_kl!=null)}function J(e){return e?html`<span class="badge badge--success pl-status">Saved</span>`:html`<span class="badge badge--warning pl-status">Pending</span>`}function ee(e){const{listEl:t,alertEl:l,emptyEl:r}=e||{};!!t?.querySelector(".pl-day-card")?(r?.classList.add("hidden"),l?.classList.remove("hidden")):(setHtml(t,""),l?.classList.add("hidden"),r?.classList.remove("hidden")),Y(e)}function te(e){const t=new Map;return(e??[]).forEach(l=>{t.has(l.date)||t.set(l.date,[]),t.get(l.date).push(l)}),[...t.entries()].sort((l,r)=>r[0].localeCompare(l[0]))}function le(e){const t=Number(e.purchase_delivery_qty_kl);return Number.isFinite(t)&&t>0?t:litresToKl(e.receipts)??""}function re(e){const t=e.map(r=>Number(r.purchase_lfr_qty_kl)).find(r=>Number.isFinite(r)&&r>0);if(t)return t;const l=e.reduce((r,a)=>r+(Number(a.receipts)||0),0);return litresToKl(l)??""}function ne(e){return e.map(l=>Number(l.purchase_lfr_total)).find(l=>Number.isFinite(l)&&l>0)??""}function v(e){return e?Number.parseFloat(String(e.value??"").trim()):NaN}function F(e){if(!e)return;const t=e.dataset.date,l=v(e.querySelector(".pl-lfr-total")),r=v(e.querySelector(".pl-lfr-qty")),a=getPurchaseLfrGstPct(),n=lfrPerKlInclGstFromTaxable(l,r,a),o=e.querySelector(".pl-lfr-per-kl");o&&(o.textContent=n!=null?`${formatCurrency(n)}/KL`:"\u2014"),e.querySelectorAll(".pl-product-block").forEach(s=>{const i=s.dataset.product,c=v(s.querySelector(".pl-buying-input")),d=v(s.querySelector(".pl-del-total")),y=v(s.querySelector(".pl-del-qty")),u=ratePerKlFromTotalAndQty(d,y),p=s.querySelector(".pl-del-per-kl");p&&(p.textContent=u!=null?`${formatCurrency(u)}/KL`:"\u2014");const h=s.querySelector(".pl-landed-value"),C=s.querySelector(".pl-landed-sub"),L=s.querySelector(".pl-landed"),q=validateBuyingRateKlInput(c),f=q.ok&&u!=null?landedBuyingRatePerLitre(q.valuePerLitre,i,t,{deliveryPerKl:u,lfrPerKl:n??0}):null,g=f!=null&&n!=null;L?.classList.toggle("is-ready",g),L?.classList.toggle("is-partial",f!=null&&!g),h&&(h.textContent=f!=null?`${formatCurrency(f)}/L`:"\u2014"),C&&(C.textContent=g?`${formatCurrency(f*1e3)}/KL incl. VAT, delivery & LFR`:f!=null?"Excludes LFR: enter the day's LFR above":"Fill rate and delivery to preview")})}function ae(e){e.querySelectorAll("input").forEach(t=>{t.addEventListener("input",()=>{t.classList.remove("pl-field-invalid");const l=t.closest(".pl-section")?.querySelector(".pl-block-error");l&&(l.textContent="",l.classList.add("hidden")),F(e)})}),F(e)}function x(e){return e?.children?.length?e.contains(document.activeElement)&&document.activeElement?.matches?.("input, textarea, select, button")?!0:[...e.querySelectorAll("input")].some(t=>t.value!==t.defaultValue):!1}const $={petrol:{label:"Petrol (MS)",code:"MS",badge:"badge--petrol"},diesel:{label:"Diesel (HSD)",code:"HSD",badge:"badge--diesel"}};function _(e){return e===""||e==null?"":String(e)}function S({id:e,label:t,cls:l,value:r,placeholder:a,unit:n,required:o=!0,hint:s,inputmode:i="decimal",maxlength:c}){return html`
      <div class="form-field pl-field">
        <label for="${e}">${t}${o?html` <abbr title="required">*</abbr>`:""}</label>
        <input
          id="${e}"
          type="text"
          inputmode="${i}"
          class="${l}"
          value="${r}"
          placeholder="${a}"
          autocomplete="off"
          ${trustedHtml(n?`data-unit="${escapeHtml(n)}"`:"")}
          ${trustedHtml(c?`maxlength="${Number(c)}"`:"")}
          ${trustedHtml(o?'required aria-required="true"':"")}
        />
        ${s?html`<span class="pl-field-hint">${s}</span>`:""}
      </div>`}function H(e,t,l){return html`
      <div class="pl-computed" aria-live="polite">
        <span class="pl-computed-label">${e}</span>
        <strong class="pl-computed-value ${t}">—</strong>
        ${l?html`<span class="pl-field-hint">${l}</span>`:""}
      </div>`}function Q(e,t){return html`
      <div class="pl-saved-summary">
        <dl class="pl-saved-figures">
          ${e.map(([l,r,a])=>html`<div><dt>${l}</dt><dd class="${a||""}">${r}</dd></div>`)}
        </dl>
        <button type="button" class="button-secondary button-small pl-edit" aria-label="${t}">Edit</button>
      </div>`}function M({badgeCls:e,code:t,title:l,sub:r,extra:a,done:n}){return html`
      <div class="pl-block-head">
        <span class="badge badge--square ${e}" aria-hidden="true">${t}</span>
        <div class="pl-block-titles">
          <h4 class="pl-block-title">${l}</h4>
          <p class="pl-block-sub">${r}</p>
        </div>
        ${a||""}
        ${J(n)}
      </div>`}function se(e,t,l){const r=normalizeProduct(e.product),a=$[r]||$.diesel,n=String(e.id),o=G(e),s=Number(e.purchase_delivery_total)>0?e.purchase_delivery_total:"",i=Number(e.receipts)||0,c=Number(e.buying_price_per_litre),d=Number.isFinite(c)&&c>0?Math.round(c*1e3*100)/100:"",y=Number(e.purchase_delivery_per_kl);return html`
      <section
        class="pl-section pl-product-block pl-product-block--${r} ${o?"is-saved":""}"
        data-dsr-id="${n}"
        data-product="${r}"
        aria-label="${a.label} purchase cost"
      >
        ${M({badgeCls:a.badge,code:a.code,title:a.label,sub:"Fuel tax invoice",extra:html`<span class="badge badge--neutral pl-receipt-badge">${formatQuantity(i)} L received</span>`,done:o})}
        ${o?Q([["Rate per Unit",`${formatCurrency(d)}/KL`],["Delivery",Number.isFinite(y)?`${formatCurrency(y)}/KL`:"\u2014"],["Invoice No.",e.supplier_invoice_no||"\u2014"],["LFR",l?"Applied":"Pending",l?"":"pl-text-warning"]],`Edit ${a.label}`):""}
        <div class="pl-section-form">
          <div class="pl-field-grid">
            ${S({id:`pl-buying-${n}`,label:"Rate per Unit",cls:"pl-buying-input",value:_(d),placeholder:"81416.47",unit:"\u20B9",hint:"Pre-VAT, per KL"})}
            ${S({id:`pl-del-total-${n}`,label:"DLY/TAXABLE CHARGE",cls:"pl-del-total",value:_(s),placeholder:"2435.80",unit:"\u20B9"})}
            ${S({id:`pl-del-qty-${n}`,label:"Quantity",cls:"pl-del-qty",value:_(le(e)),placeholder:"4",unit:"KL"})}
            ${H("Delivery","pl-del-per-kl","Charge per KL")}
          </div>
          <details class="pl-optional" ${trustedHtml(e.supplier_invoice_no?"open":"")}>
            <summary>Invoice reference <span class="muted">(optional)</span></summary>
            <div class="pl-field-grid pl-field-grid--2">
              ${S({id:`pl-inv-${n}`,label:"Invoice No.",cls:"pl-inv-input",value:e.supplier_invoice_no||"",placeholder:"1202801092",required:!1,inputmode:"text",maxlength:40,hint:"Links the purchase invoice from the vault"})}
              ${S({id:`pl-gstin-${n}`,label:"Supplier GSTIN",cls:"pl-gstin-input",value:e.supplier_gstin||t||"",placeholder:"15-character GSTIN",required:!1,inputmode:"text",maxlength:15})}
            </div>
          </details>
          <div class="pl-block-foot">
            <div class="pl-landed">
              <span class="pl-computed-label">Landed buying price</span>
              <strong class="pl-landed-value">—</strong>
              <span class="pl-landed-sub">Fill rate and delivery to preview</span>
            </div>
            <button type="button" class="button-primary pl-buying-save" data-dsr-id="${n}" data-product="${r}">
              Save ${a.code}
            </button>
          </div>
        </div>
        <p class="pl-block-error error hidden" role="alert"></p>
      </section>`}function ie(e,t,l){const r=k(t),a=t.find(n=>n.purchase_lfr_per_kl!=null);return html`
      <section class="pl-section pl-lfr-block ${r?"is-saved":""}" data-date="${e}" aria-label="LFR for the day">
        ${M({badgeCls:"badge--neutral",code:"LFR",title:"LFR for DC \xB7 MS + HSD",sub:`LFR tax invoice \xB7 shared by both products \xB7 CGST+SGST ${String(l)}% added`,done:r})}
        ${r?Q([["TAXABLE AMT",formatCurrency(Number(a?.purchase_lfr_total)||0)],["Total quantity",`${formatQuantity(Number(a?.purchase_lfr_qty_kl)||0)} KL`],["LFR incl. GST",`${formatCurrency(Number(a?.purchase_lfr_per_kl)||0)}/KL`]],"Edit LFR"):""}
        <div class="pl-section-form">
          <div class="pl-field-grid">
            ${S({id:`pl-lfr-total-${e}`,label:"TAXABLE AMT",cls:"pl-lfr-total",value:_(ne(t)),placeholder:"2133.00",unit:"\u20B9"})}
            ${S({id:`pl-lfr-qty-${e}`,label:"Total quantity",cls:"pl-lfr-qty",value:_(re(t)),placeholder:"12",unit:"KL",hint:"Whole load, MS + HSD"})}
            ${H("LFR incl. GST","pl-lfr-per-kl","Applied to both products")}
          </div>
          <div class="pl-block-foot pl-block-foot--end">
            <button type="button" class="button-primary pl-lfr-save" data-date="${e}">Save LFR</button>
          </div>
        </div>
        <p class="pl-block-error error hidden" role="alert"></p>
      </section>`}function oe(e){const t=[{code:"LFR",badge:"badge--neutral",done:k(e)}];return e.forEach(l=>{const r=$[normalizeProduct(l.product)]||$.diesel;t.push({code:r.code,badge:r.badge,done:G(l)})}),t}function ce(e,t,l,r,a){const n=oe(t),o=n.filter(i=>i.done).length,s=k(t);return html`
      <li class="pl-day-card" data-date="${e}">
        <details class="pl-day" ${trustedHtml(a?"open":"")}>
          <summary class="pl-day-head">
            <span class="icon icon--chevron-down pl-day-chevron" aria-hidden="true"></span>
            <span class="pl-day-heading">
              <span class="pl-day-eyebrow">Receipt day</span>
              <span class="pl-day-title">${formatDisplayDate(e)}</span>
            </span>
            <span class="pl-day-badges">
              ${n.map(i=>html`<span class="badge ${i.done?"badge--success":i.badge} pl-chip ${i.done?"is-done":""}"
                  title="${i.code}: ${i.done?"saved":"pending"}">${i.done?"\u2713 ":""}${i.code}</span>`)}
              <span class="pl-day-progress" aria-label="${o} of ${n.length} sections saved">
                <span class="pl-day-progress-bar" aria-hidden="true">
                  <span style="${trustedHtml(`width:${Math.round(o/n.length*100)}%`)}"></span>
                </span>
                <span class="pl-day-progress-text">${o}/${n.length} saved</span>
              </span>
            </span>
          </summary>
          <div class="pl-day-body">
            ${ie(e,t,r)}
            ${t.map(i=>se(i,l,s))}
          </div>
        </details>
      </li>`}function de(e){const{listEl:t,alertEl:l,emptyEl:r}=e||{};!t||t.children.length||r&&!r.classList.contains("hidden")||(r?.classList.add("hidden"),l?.classList.remove("hidden"),setHtml(t,html`<li class="pl-loading" aria-busy="true">
        <span class="sr-only">Loading receipt days…</span>
        <span class="skeleton-row" aria-hidden="true"></span>
        <span class="skeleton-row" aria-hidden="true"></span>
      </li>`))}function O(e,t){const{listEl:l,errorEl:r}=t;if(!l)return;T(r);const a=PumpSettings.getCachedSync().reports?.fuelSupplierGstin||AppConfig.DEFAULT_REPORTS.fuelSupplierGstin||"",n=getPurchaseLfrGstPct(),o=te(e);setHtml(l,html`${o.map(([s,i],c)=>ce(s,i,a,n,I.get(s)??c===0))}`),applyInputUnits(l),ee(t),Z(t),l.querySelectorAll(".pl-day-card").forEach(s=>ae(s)),l.querySelectorAll(".pl-day").forEach(s=>{s.addEventListener("toggle",()=>{const i=s.closest(".pl-day-card")?.dataset.date;i&&I.set(i,s.open),P(t)})}),l.querySelectorAll(".pl-buying-save").forEach(s=>{s.addEventListener("click",()=>pe(s.dataset.dsrId,t))}),l.querySelectorAll(".pl-lfr-save").forEach(s=>{s.addEventListener("click",()=>ue(s.dataset.date,t))}),l.querySelectorAll(".pl-edit").forEach(s=>{s.addEventListener("click",()=>{const i=s.closest(".pl-section");i?.classList.remove("is-saved"),i?.classList.add("is-editing"),i?.querySelector(".pl-section-form input")?.focus()})})}function U(e){if(!e)return()=>{};const t=e.textContent;return e.disabled=!0,e.textContent="Saving\u2026",()=>{e.disabled=!1,e.textContent=t}}async function V(e,t,l){const{listEl:r,onSaved:a}=e;typeof AppCache<"u"&&AppCache&&CacheInvalidation.invalidate("dsr");try{typeof a=="function"?await a():await z({...e,force:!0})}catch(n){AppError.report(n,{context:l,type:"dsr"})}W(r,t)}async function ue(e,t){const{listEl:l,errorEl:r}=t,n=l?.querySelector(`.pl-day-card[data-date="${CSS.escape?CSS.escape(e):e}"]`)?.querySelector(".pl-lfr-block"),o=n?.querySelector(".pl-lfr-total"),s=n?.querySelector(".pl-lfr-qty");K(n),T(r);const i=v(o),c=v(s),d=lfrPerKlInclGstFromTaxable(i,c,getPurchaseLfrGstPct());if(d==null){const h=!Number.isFinite(i)||i<0;h&&b(o),(!Number.isFinite(c)||c<=0)&&b(s),m(t,n,"Enter TAXABLE AMT (\u20B9) and total quantity (KL) from the LFR invoice.",h?o:s);return}if(!window.supabaseClient?.rpc){m(t,n,"Not connected. Refresh the page and try again.");return}const y=U(n?.querySelector(".pl-lfr-save")),u=B(l,{excludeLfrDate:e}),p=await window.supabaseClient.rpc("update_dsr_purchase_lfr",{p_date:e,p_lfr_total:i,p_lfr_qty_kl:c,p_lfr_per_kl:d});if(p.error){AppError.report(p.error,{context:"handleSaveLfr",type:"dsr"}),m(t,n,p.error.message||"Could not save LFR. Ensure you are logged in as admin."),y();return}AppError.showToast?.(`LFR saved for ${formatDisplayDate(e)}.`,"success"),await V(t,u,"handleSaveLfr.onSaved")}async function pe(e,t){const{listEl:l,errorEl:r}=t,a=CSS.escape?CSS.escape(e):e,n=l?.querySelector(`.pl-product-block[data-dsr-id="${a}"]`),o=n?.closest(".pl-day-card"),s=document.getElementById(`pl-buying-${e}`),i=document.getElementById(`pl-inv-${e}`),c=document.getElementById(`pl-gstin-${e}`),d=n?.querySelector(".pl-del-total"),y=n?.querySelector(".pl-del-qty"),u=n?.querySelector(".pl-buying-save"),p=n?.dataset?.product,h=o?.dataset?.date||null;K(n),T(r);const C=v(s),L=validateBuyingRateKlInput(C);if(!L.ok){b(s),m(t,n,L.message||`Enter a valid ${getPlBuyingPriceFieldLabel().toLowerCase()}.`,s);return}const q=buyingRatePerLitreForDb(L.valuePerLitre,p);if(q==null){b(s),m(t,n,`Enter a valid ${getPlBuyingPriceFieldLabel().toLowerCase()}.`,s);return}const f=v(d),g=v(y),X=ratePerKlFromTotalAndQty(f,g);if(X==null){(!Number.isFinite(f)||f<0)&&b(d),(!Number.isFinite(g)||g<=0)&&b(y),m(t,n,"Enter DLY/TAXABLE CHARGE (\u20B9) and Quantity (KL) from the fuel invoice \u2014 required to save.",!Number.isFinite(f)||f<0?d:y);return}const w=(i?.value??"").trim();let E=(c?.value??"").trim().toUpperCase();if(E||(E=(PumpSettings.getCachedSync().reports?.fuelSupplierGstin||AppConfig.DEFAULT_REPORTS.fuelSupplierGstin||"").toString().trim().toUpperCase()),E&&!/^[0-9A-Z]{15}$/.test(E)){b(c),m(t,n,"Supplier GSTIN must be 15 characters (or leave blank).",c);return}if(!window.supabaseClient?.rpc){m(t,n,"Not connected. Refresh the page and try again.");return}const ve=U(u);let D=null;try{w&&(D=await A(w,h||null))}catch{D=null}const me=B(l,{excludeDsrId:e}),N=await window.supabaseClient.rpc("update_dsr_buying_price",{p_dsr_id:e,p_value:q,p_supplier_invoice_no:w||null,p_supplier_gstin:E||null,p_invoice_document_id:D,p_purchase_delivery_per_kl:X,p_purchase_delivery_total:f,p_purchase_delivery_qty_kl:g});if(N.error){AppError.report(N.error,{context:"handleSaveBuyingPrice",type:"dsr"}),m(t,n,N.error.message||"Could not save. Ensure you are logged in as admin."),ve();return}AppError.showToast?.(`${($[p]||$.diesel).label} cost saved for ${formatDisplayDate(h)}.`,"success"),await V(t,me,"handleSaveBuyingPrice.onSaved")}async function fe(e){const t=await DsrQueries.fetchMissingBuyingPriceRows({force:e});if(t.error||!t.data?.length)return t;const l=[...new Set(t.data.map(a=>a.date))],r=await DsrQueries.fetchReceiptRowsForDates(l);return r.error?t:r}async function z(e={}){const{force:t=!1,listEl:l,alertEl:r,emptyEl:a,errorEl:n,countEl:o}=e;if(!t&&x(l))return null;de(e);const{data:s,error:i}=await fe(t);if(i)return AppError.report(i,{context:"BuyingPriceEntry.refresh"}),setHtml(l,""),r?.classList.add("hidden"),a?.classList.add("hidden"),o?.classList.add("hidden"),e.toggleAllEl?.classList.add("hidden"),R(n,i.message||"Could not load receipt days needing a buying price."),[];if(!t&&x(l))return null;const c=s??[];return O(c,e),c}function ye(){document.querySelector(".pl-day[open] .pl-section:not(.is-saved) .pl-section-form input")?.focus({preventScroll:!0})}j.BuyingPriceEntry={findVaultDocumentIdForInvoice:A,renderMissingBuyingList:O,refresh:z,focusFirstInput:ye,hasUnsavedEdits:x}})(typeof window<"u"?window:globalThis);
