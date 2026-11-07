// shortcut: UTF-8 bytes / 3 estimates tokens across providers; use a model tokenizer if exact counts become required.
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export function clipTokens(text: string, budget: number, tail = false): string {
  if (budget <= 0) return "";
  if (estimateTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const part = tail ? text.slice(-mid) : text.slice(0, mid);
    if (estimateTokens(part) <= budget) low = mid;
    else high = mid - 1;
  }
  const part = tail ? text.slice(text.length - low) : text.slice(0, low);
  return tail ? part.replace(/^[\uDC00-\uDFFF]/, "") : part.replace(/[\uD800-\uDBFF]$/, "");
}
