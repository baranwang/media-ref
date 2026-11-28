import {
  createThemeBaseCss,
  createThemeRule,
  themeTokenClasses,
  type HighlightTheme,
  type HighlightThemeToken,
} from "@tanstack/highlight/theme";

// Colors are site theme tokens, so one rule covers light and dark. Per the design, only strings
// get the accent and comments are muted; every other token keeps the foreground color.
const mediarefTheme: HighlightTheme = {
  name: "mediaref",
  type: "dark",
  background: "transparent",
  foreground: "var(--foreground)",
  tokens: {
    ...(Object.fromEntries(
      themeTokenClasses.map((token) => [token, "var(--foreground)"]),
    ) as Record<HighlightThemeToken, string>),
    string: "var(--primary)",
    comment: "var(--muted-foreground)",
  },
};

/** Code block CSS for TanStack Highlight output (`pre.th-code`). */
export const codeThemeCss = `${createThemeBaseCss()}\n${createThemeRule("pre.th-code", mediarefTheme)}`;
