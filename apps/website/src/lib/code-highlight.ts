export interface CodeToken {
  text: string;
  kind: "plain" | "string" | "comment";
}

const STRING = /"(?:[^"\\]|\\.)*"/g;

/**
 * The docs' code style: a comment line is muted, double-quoted string values are accented, and
 * JSON keys (a string followed by `:`) stay plain.
 */
export function highlightLine(line: string): CodeToken[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("# ")) {
    return [{ text: line, kind: "comment" }];
  }
  const tokens: CodeToken[] = [];
  let last = 0;
  for (const match of line.matchAll(STRING)) {
    const end = match.index + match[0].length;
    if (/^\s*:/.test(line.slice(end))) continue;
    if (match.index > last) tokens.push({ text: line.slice(last, match.index), kind: "plain" });
    tokens.push({ text: match[0], kind: "string" });
    last = end;
  }
  if (last < line.length) tokens.push({ text: line.slice(last), kind: "plain" });
  return tokens;
}
