const SUBMITTED_PROMPT_PREFIX = "› ";
const ASSISTANT_BLOCK_PREFIX = "• ";

const TOOL_BLOCK_PREFIXES = [
  "Called",
  "Calling",
  "Edited",
  "Explored",
  "Ran",
  "Read",
  "Searched",
  "Updated Plan",
  "Viewed",
  "Waited",
  "Working",
] as const;

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRule(line: string): boolean {
  return /^[─━-]{8,}/.test(line.trim());
}

function isToolBlock(firstLine: string): boolean {
  return TOOL_BLOCK_PREFIXES.some(
    (prefix) => firstLine === prefix || firstLine.startsWith(`${prefix} `),
  );
}

function promptBlock(lines: ReadonlyArray<string>, start: number): string {
  const parts = [lines[start]?.trimStart().slice(SUBMITTED_PROMPT_PREFIX.length) ?? ""];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.startsWith(ASSISTANT_BLOCK_PREFIX) || isRule(line)) break;
    parts.push(line.trim());
  }
  return normalizeInlineText(parts.join(" "));
}

function findPromptEnd(lines: ReadonlyArray<string>, latestUserText: string): number | null {
  const normalizedPrompt = normalizeInlineText(latestUserText);
  if (normalizedPrompt.length === 0) return null;

  let promptEnd: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.trimStart().startsWith(SUBMITTED_PROMPT_PREFIX)) continue;
    if (promptBlock(lines, index) !== normalizedPrompt) continue;
    let end = index + 1;
    while (end < lines.length && (lines[end]?.trim().length ?? 0) > 0) end += 1;
    promptEnd = end;
  }
  return promptEnd;
}

function assistantBlock(
  lines: ReadonlyArray<string>,
  start: number,
): {
  readonly nextIndex: number;
  readonly markdown: string | null;
} {
  const firstLine = lines[start]?.trimStart().slice(ASSISTANT_BLOCK_PREFIX.length).trim() ?? "";
  const blockLines = [firstLine];
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trimStart().startsWith(ASSISTANT_BLOCK_PREFIX) || isRule(line)) break;
    blockLines.push(line.startsWith("  ") ? line.slice(2) : line);
  }

  if (isToolBlock(firstLine)) return { nextIndex: index, markdown: null };
  const markdown = blockLines.join("\n").trim();
  return { nextIndex: index, markdown: markdown.length > 0 ? markdown : null };
}

export function extractHerdrLiveAssistantMarkdown(
  transcript: string,
  latestUserText: string,
): string | null {
  const lines = transcript.replace(/\r\n?/g, "\n").split("\n");
  const promptEnd = findPromptEnd(lines, latestUserText);
  if (promptEnd === null) return null;

  const blocks: string[] = [];
  for (let index = promptEnd; index < lines.length; ) {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();
    if (trimmed.startsWith(SUBMITTED_PROMPT_PREFIX)) break;
    if (!trimmed.startsWith(ASSISTANT_BLOCK_PREFIX)) {
      index += 1;
      continue;
    }
    const block = assistantBlock(lines, index);
    if (block.markdown) blocks.push(block.markdown);
    index = block.nextIndex;
  }

  const markdown = blocks.join("\n\n").trim();
  return markdown.length > 0 ? markdown : null;
}
