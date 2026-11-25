// Decides whether an agent stopped because its plan or quota ran out.
const PATTERNS = [
  /\b(usage|session|weekly|daily|5[- ]hour|opus|sonnet|rate|request|message|credit|quota)s?[ -]limits?\b.{0,40}\b(reached|exceeded|hit)\b/i,
  /\b(reached|exceeded|hit)\b.{0,40}\b(usage|session|weekly|daily|5[- ]hour|rate|request|message|quota|plan|your)\b.{0,20}\b(limit|quota)\b/i,
  /you'?ve hit your .{0,20}limit/i,
  /\bout of (extra usage|credits|quota)\b/i,
  /\bquota (exceeded|exhausted)\b|\bexceeded your current quota\b/i,
  /RESOURCE_EXHAUSTED|usageLimitExceeded|rateLimitExceeded|insufficient_quota/,
  /\b(status|error|code|http)[ :=]*429\b|\b429 too many requests\b/i,
  /credit balance is too low/i,
];
export function isLimitError(text) { return !!text && PATTERNS.some((p) => p.test(String(text).slice(0, 4000))); }
