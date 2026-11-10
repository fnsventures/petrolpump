import assert from "node:assert/strict";
import test from "node:test";
import { createSandbox, loadScripts } from "./loadGlobals.mjs";

function load() {
  const sandbox = createSandbox();
  loadScripts(sandbox, ["js/utils.js"]);
  return sandbox;
}

test("html escapes every interpolated value", () => {
  const { html } = load();
  const name = `<img src=x onerror="alert('1')">&`;
  assert.equal(
    String(html`<a title="${name}">${name}</a>`),
    `<a title="&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;">&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;</a>`
  );
});

test("nested html and trustedHtml pass through; arrays join; empty values render nothing", () => {
  const { html, trustedHtml } = load();
  const rows = ["a<b", "c"].map((r) => html`<li>${r}</li>`);
  assert.equal(
    String(html`<ul>${rows}${null}${undefined}${false}${0}${trustedHtml("<hr>")}</ul>`),
    "<ul><li>a&lt;b</li><li>c</li>0<hr></ul>"
  );
});

test("setHtml writes markup only for SafeHtml; a plain string is escaped", () => {
  const { html, setHtml } = load();
  const el = { innerHTML: "" };
  setHtml(el, html`<b>${"<i>"}</b>`);
  assert.equal(el.innerHTML, "<b>&lt;i&gt;</b>");
  setHtml(el, "<script>x</script>");
  assert.equal(el.innerHTML, "&lt;script&gt;x&lt;/script&gt;");
  setHtml(el, "");
  assert.equal(el.innerHTML, "");
  assert.doesNotThrow(() => setHtml(null, html`<b></b>`));
});
