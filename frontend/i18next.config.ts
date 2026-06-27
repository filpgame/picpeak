import { defineConfig } from 'i18next-cli';
import { typescriptPlugin } from "./scripts/i18nextExtractionHelper";


export default defineConfig({
  locales: ['en', 'de', 'nl', 'pt', 'ru', 'fr'],

  extract: {
    input: ['src/**/*.{ts,tsx,js,jsx}'],
    // node-glob (used internally by i18next-cli) ignores `!`-prefixed
    // negation patterns in `input`; exclusions must live in `ignore`.
    // `.d.ts` shims (e.g. RestoreWizard.d.ts) are ambient declarations
    // that SWC rejects when parsed as normal modules, which would abort
    // the run with a non-zero exit even when no keys changed.
    ignore: ['src/**/*.{test,spec}.{ts,tsx}', 'src/**/*.d.ts', 'src/**/*.d.tsx'],
    output: 'src/i18n/locales/{{language}}.json',
    defaultNS: false,

    primaryLanguage: 'en',

    removeUnusedKeys: true,

    // Dynamic keys to preserve (e.g.: t(`errors.${code}`))
    preservePatterns: [],

    preserveContextVariants: true,

    indentation: 2,
    sort: false,
  },
  plugins: [typescriptPlugin(["./src/App.tsx"]) ]
});