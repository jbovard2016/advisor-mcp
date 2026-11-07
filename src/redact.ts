const RULES: Array<{ name: string; pattern: RegExp; replacement: string | ((match: string, ...groups: string[]) => string) }> = [
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replacement: "[REDACTED PRIVATE KEY]",
  },
  {
    name: "anthropic-key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED ANTHROPIC KEY]",
  },
  {
    name: "openai-key",
    pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED OPENAI KEY]",
  },
  {
    name: "github-token",
    pattern: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g,
    replacement: "[REDACTED GITHUB TOKEN]",
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED AWS ACCESS KEY]",
  },
  {
    name: "bearer-token",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "assigned-secret",
    pattern:
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b(["']?\s*[:=]\s*)(["']?)([A-Za-z0-9._~+/-]{12,})\3/gi,
    replacement: (_match: string, key: string, separator: string) =>
      `${key}${separator}[REDACTED]`,
  },
];

export interface RedactionResult {
  text: string;
  count: number;
}

export function redactSecrets(input: string, secrets: string[] = []): RedactionResult {
  let text = input;
  let count = 0;
  for (const secret of secrets.filter(Boolean)) {
    const parts = text.split(secret);
    count += parts.length - 1;
    text = parts.join("[REDACTED]");
  }
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      if (typeof rule.replacement === "function") {
        return rule.replacement(...(args as [string, ...string[]]));
      }
      return rule.replacement;
    });
  }
  return { text, count };
}
