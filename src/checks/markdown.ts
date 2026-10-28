// Agent-written text (a path from the diff, a matched line) quoted in a check summary.

/** A Markdown code span: control characters become `?` (a newline would end the span), and a backtick in the text keeps it whole. */
export function mdCode(text: string): string {
  const s = text.replace(/\p{Cc}/gu, '?');
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
}
