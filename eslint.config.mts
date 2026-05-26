import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import css from "@eslint/css";
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".vscode/**",
      ".git/**",
      "package-lock.json",
      "*.md",
      "*.css",
      "*.js",
      "!eslint.config.mts",
    ],
  },
  { files: ["src/**/*.{js,mjs,cjs,ts,mts,cts}"], plugins: { js }, extends: ["js/recommended"], languageOptions: { globals: {...globals.browser, ...globals.node} } },
  tseslint.configs.recommended,
  {
    files: ["src/**/*.test.{ts,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/**/*.{ts,mts,cts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // Disable ESLint rules that conflict with Prettier
  eslintConfigPrettier,
  { files: ["src/**/*.json"], plugins: { json }, language: "json/json", extends: ["json/recommended"] },
  { files: ["src/**/*.jsonc"], plugins: { json }, language: "json/jsonc", extends: ["json/recommended"] },
  { files: ["src/**/*.json5"], plugins: { json }, language: "json/json5", extends: ["json/recommended"] },
  { files: ["src/**/*.md"], plugins: { markdown }, language: "markdown/commonmark", extends: ["markdown/recommended"] },
  { files: ["src/**/*.css"], plugins: { css }, language: "css/css", extends: ["css/recommended"] },
]);
