import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Core runs unchanged in browsers, React Native and Node: no Node built-ins, no other subpaths.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["node:*", "../server/*", "../react-native/*", "../cli/*", "pg"] },
      ],
    },
  },
  { files: ["test/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  { files: ["scripts/**/*.mjs", "examples/**/server.mjs", "test/**/*.mjs"], languageOptions: { globals: globals.node } },
  { files: ["examples/**/public/**/*.js"], languageOptions: { globals: globals.browser } },
);
