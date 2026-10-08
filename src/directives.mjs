/** Identify only actual line-leading ExtendScript preprocessor directives.
 * Lines inside block comments and strings are not interpreted as includes.
 * This lexer deliberately never parses JavaScript grammar or executes source.
 */
export function scanDirectives(text) {
  const directives = [];
  let blockComment = false;
  let offset = 0;
  while (offset < text.length) {
    let lineEnd = offset;
    while (lineEnd < text.length && text[lineEnd] !== "\n" && text[lineEnd] !== "\r") lineEnd++;
    const line = text.slice(offset, lineEnd);
    if (!blockComment) {
      const lead = /^[ \t]*#([a-zA-Z]+)\b/.exec(line);
      if (lead) {
        const kind = lead[1].toLowerCase();
        if (kind === "include") {
          const valid = /^[ \t]*#include[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|<([^>\r\n]+)>)[ \t]*(?:\/\/.*)?$/i.exec(line);
          directives.push({
            kind: valid ? "include" : "invalid-include",
            value: valid ? valid[1] || valid[2] || valid[3] : null,
            start: offset, end: lineEnd
          });
        } else if (kind === "target" || kind === "targetengine") {
          const valid = /^[ \t]*#(?:target|targetengine)[ \t]+([^\r\n]+)$/i.exec(line);
          if (valid) directives.push({ kind, value: valid[1].trim(), start: offset, end: lineEnd });
        }
      }
    }
    // Track block comments, skipping quoted strings and end-of-line comments.
    // The preprocessor cannot place a real directive after other tokens.
    for (let i = 0; i < line.length;) {
      if (blockComment) {
        const end = line.indexOf("*/", i);
        if (end < 0) break;
        blockComment = false;
        i = end + 2;
      } else if (line.startsWith("//", i)) {
        break;
      } else if (line.startsWith("/*", i)) {
        blockComment = true;
        i += 2;
      } else if (line[i] === "'" || line[i] === '"') {
        const quote = line[i++];
        while (i < line.length) {
          if (line[i] === "\\") i += 2;
          else if (line[i++] === quote) break;
        }
      } else i++;
    }
    offset = lineEnd;
    if (text[offset] === "\r") offset++;
    if (text[offset] === "\n") offset++;
  }
  return directives;
}