import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["js/vendor/**", "js/pdf/**", "js/env.js", "_site/**", "node_modules/**", "supabase/functions/**"],
  },
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser },
    },
    rules: {
      "no-undef": "error",
      // Markup from strings goes through setHtml(el, html`...`) in js/utils.js, which escapes
      // every interpolated value. Warn (not error) until the existing call sites move over.
      "no-restricted-syntax": [
        "warn",
        {
          selector: "AssignmentExpression > MemberExpression.left[property.name=/^(inner|outer)HTML$/]",
          message: "Use setHtml(el, html`...`) from js/utils.js instead of assigning innerHTML/outerHTML.",
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: "Use html`...` from js/utils.js and insert the result instead of insertAdjacentHTML with a raw string.",
        },
      ],
    },
  },
  {
    // esbuild entries (js/vendor, js/pdf); the only ES modules in js/.
    files: ["js/supabaseLoginClient.js", "js/chartClient.js", "js/pdfPreviewClient.js"],
    languageOptions: { sourceType: "module" },
  },
];
