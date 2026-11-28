import { createThemeCss, type HighlightTheme } from "@tanstack/highlight/theme";

// Built from site and Tailwind palette variables. Strings keep the lime accent from the design;
// the other colors are chosen to sit next to it.
const dark: HighlightTheme = {
  name: "mediaref-dark",
  type: "dark",
  background: "transparent",
  foreground: "var(--foreground)",
  tokens: {
    token: "var(--foreground)",
    variable: "var(--foreground)",
    property: "var(--foreground)",
    heading: "var(--foreground)",
    "code-inline": "var(--foreground)",
    string: "var(--primary)",
    comment: "var(--muted-foreground)",
    meta: "var(--muted-foreground)",
    operator: "var(--color-neutral-400)",
    keyword: "var(--color-violet-400)",
    selector: "var(--color-violet-300)",
    function: "var(--color-sky-300)",
    command: "var(--color-sky-300)",
    link: "var(--color-sky-300)",
    type: "var(--color-teal-300)",
    number: "var(--color-amber-300)",
    literal: "var(--color-amber-300)",
    attr: "var(--color-amber-300)",
    tag: "var(--color-rose-300)",
    inserted: "var(--color-lime-400)",
    deleted: "var(--color-red-400)",
  },
};

const light: HighlightTheme = {
  name: "mediaref-light",
  type: "light",
  background: "transparent",
  foreground: "var(--foreground)",
  tokens: {
    token: "var(--foreground)",
    variable: "var(--foreground)",
    property: "var(--foreground)",
    heading: "var(--foreground)",
    "code-inline": "var(--foreground)",
    // --primary (lime-400) is too light to read on white.
    string: "var(--color-lime-700)",
    comment: "var(--muted-foreground)",
    meta: "var(--muted-foreground)",
    operator: "var(--color-neutral-500)",
    keyword: "var(--color-violet-600)",
    selector: "var(--color-violet-700)",
    function: "var(--color-sky-700)",
    command: "var(--color-sky-700)",
    link: "var(--color-sky-700)",
    type: "var(--color-teal-700)",
    number: "var(--color-amber-700)",
    literal: "var(--color-amber-700)",
    attr: "var(--color-amber-700)",
    tag: "var(--color-rose-600)",
    inserted: "var(--color-lime-700)",
    deleted: "var(--color-red-600)",
  },
};

/** Code block CSS for TanStack Highlight output (`pre.th-code`), light and dark. */
export const codeThemeCss = createThemeCss({
  light,
  dark,
  lightSelector: ":root",
  darkSelector: ".dark",
});
