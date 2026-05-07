// Flat ESLint config (ESLint v9+).
//
// Scope: a11y rules only. We deliberately do NOT enable general TypeScript /
// React style rules — the project doesn't have a lint baseline and surfacing
// thousands of style violations now would block real work. The goal here is
// to catch WCAG-relevant issues at lint time, alongside the runtime
// `audit:a11y` script.
//
// Add general rules later when the team is ready to maintain them.
//
// Run: `npm run lint:a11y` for the focused report; `npx eslint .` for raw.

import jsxA11y from "eslint-plugin-jsx-a11y";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    // Top-level ignore patterns.
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-electron/**",
      "build/**",
      "release/**",
      "drizzle/**",
      "coverage/**",
      "client/tsconfig.tsbuildinfo",
      "client-aac/tsconfig.tsbuildinfo",
      "**/*.bak",
      // Generated / vendored:
      "client/src/i18n/*.bak",
      "generative-ai/**",
      "reference-files/**",
      "tobii-test/**",
      "games/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,jsx,js,mjs,cjs}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "jsx-a11y": jsxA11y,
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      // jsx-a11y recommended set — these are the WCAG-relevant rules.
      ...jsxA11y.configs.recommended.rules,

      // Localize a few rules to project conventions:

      // Our `<button>` and `<Button>` already require type=button when not in
      // a form (we use them with onClick handlers); enforce explicitly.
      // A button without `type` defaults to `type="submit"` inside a form,
      // which can cause surprise submissions.
      // (Not in the recommended set; opt-in.)
      "react/button-has-type": "warn",

      // Allow `aria-label` on non-interactive elements when used for a
      // labelled-by relationship — the AAC student board has many such
      // patterns. The recommended rule is too strict for this codebase.
      "jsx-a11y/no-noninteractive-element-interactions": "off",

      // Click handlers on non-button elements: warn (not error) — we have
      // a few legitimate cases (overlays, drag handles). Manually audit.
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",

      // Default heading-has-content rule errors on dynamic children; warn instead.
      "jsx-a11y/heading-has-content": "warn",

      // jsx-a11y/aria-role inspects the `role` attribute on every JSX element.
      // We have React components that accept `role` as a domain prop (e.g.
      // <InvitesList role="outgoing" />). ignoreNonDOM scopes the rule to
      // lowercase HTML elements only — PascalCase component instances are
      // skipped because their `role` is a prop, not an HTML attribute.
      "jsx-a11y/aria-role": ["error", { ignoreNonDOM: true }],

      // Teach the label-has-associated-control rule about our shadcn/Radix
      // form controls — without this it flags every <label><Input/></label>
      // wrapping pattern as if Input were arbitrary content. The list mirrors
      // the components we actually treat as form controls in the codebase.
      "jsx-a11y/label-has-associated-control": [
        "error",
        {
          labelComponents: ["Label"],
          controlComponents: [
            "Input",
            "Textarea",
            "Select",
            "Checkbox",
            "RadioGroup",
            "Switch",
            "Slider",
            "InputOTP",
            "PhoneInput",
            "CardElement", // Stripe payment form field (iframe-backed)
          ],
          assert: "either",
        },
      ],

      // The recommended set already enables alt-text, aria-* checks, label,
      // anchor-is-valid, etc. — leave those at error severity.
    },
  },
  {
    // Server / shared TypeScript — disable React + a11y rules entirely;
    // there's no JSX, the rules don't apply, and noise muddies the report.
    files: ["server/**/*.{ts,js}", "shared/**/*.{ts,js}", "scripts/**/*.{ts,js,mjs}"],
    rules: Object.fromEntries(
      Object.keys(jsxA11y.configs.recommended.rules).map((k) => [k, "off"]),
    ),
  },
];
