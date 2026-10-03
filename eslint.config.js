// Flat ESLint config for the monorepo. Type-aware rules are left to `tsc --noEmit` (strict);
// ESLint focuses on correctness smells, React hooks, and the project's safety bans.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const safetyBans = {
  "no-restricted-syntax": [
    "error",
    {
      // DESIGN.md §8.1: fonts_static extraction must never touch the network.
      selector: "MemberExpression[object.name='juice'][property.name=/^(juiceResources|juiceFile|juiceDocument|inlineDocument)$/]",
      message: "juice network/file helpers are banned (DESIGN.md §8.1); use juice(html) only.",
    },
    {
      selector: "CallExpression[callee.name='eval']",
      message: "eval is forbidden.",
    },
  ],
  "no-restricted-imports": [
    "error",
    {
      paths: [
        { name: "web-resource-inliner", message: "Banned: it fetches remote resources (DESIGN.md §8.1)." },
        { name: "next/image", message: "Never use next/image (sender images must go through the sandboxed viewer, DESIGN.md §11.5)." },
      ],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "apps/view/api/**",
      "**/coverage/**",
      "docs/**",
      "fixtures/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: {
      ...safetyBans,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["info", "warn", "error", "debug"] }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/scripts/**", "**/test/**", "**/*.test.ts", "**/build.mjs"],
    rules: { "no-console": "off" },
  },
);
