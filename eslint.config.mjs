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
    },
  },
  {
    // esbuild entries (js/vendor, js/pdf); the only ES modules in js/.
    files: ["js/supabaseLoginClient.js", "js/chartClient.js", "js/pdfPreviewClient.js"],
    languageOptions: { sourceType: "module" },
  },
];
