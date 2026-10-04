/**
 * Secrets handling — masking convention for API keys and other
 * credentials managed via /gsd-settings-integrations (ADR-457 build-at-publish:
 * the hand-written bin/lib/secrets.cjs collapsed to a TypeScript source of
 * truth). Behaviour is preserved byte-for-behaviour from the prior hand-written
 * .cjs; only types are added.
 *
 * This module does not read the filesystem.
 */

export const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'brave_search',
  'firecrawl',
  'exa_search',
]);

export function isSecretKey(keyPath: string): boolean {
  return SECRET_CONFIG_KEYS.has(keyPath);
}

/** Scalar types that stringify meaningfully. */
type MaskableValue = string | number | boolean | null | undefined;

export function maskSecret(value: MaskableValue): string {
  if (value === null || value === undefined || value === '')
    return '(unset)';
  const s = String(value);
  if (s.length < 8)
    return '****';
  return '****' + s.slice(-4);
}

export function maskIfSecret(keyPath: string, value: MaskableValue): MaskableValue {
  return isSecretKey(keyPath) ? maskSecret(value) : value;
}

// ─── Free-text redaction ──────────────────────────────────────────────────────

export const REDACTED = '[REDACTED]';

/**
 * Credential shapes redacted out of free text before it leaves the process —
 * a transcript excerpt, a normalized command key. The token shapes mirror
 * scripts/secret-scan.sh (the repo's commit-time scanner); the assignment and
 * URL-credential forms add the cases a shell command line carries inline.
 * Order matters: `sk-ant-` before the generic `sk-`, the private-key block
 * before anything that could match inside it.
 *
 * Each entry's `replace` keeps the non-secret part (a key name, a URL scheme
 * and user) so a redacted excerpt still says what was there.
 */
const SECRET_TEXT_PATTERNS: ReadonlyArray<{ pattern: RegExp; replace: string }> = [
  // PEM armour is exactly five dashes; spelled `-{5}` so the pattern says so.
  { pattern: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}[\s\S]*?(?:-{5}END [A-Z ]*PRIVATE KEY-{5}|$)/g, replace: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  { pattern: /(aws_secret_access_key\s*[:=]\s*)[A-Za-z0-9/+=]{40}/gi, replace: `$1${REDACTED}` },
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { pattern: /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{24,}/g, replace: REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { pattern: /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, replace: `hooks.slack.com/services/${REDACTED}` },
  { pattern: /\bAIza[A-Za-z0-9_-]{35}/g, replace: REDACTED },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, replace: `$1${REDACTED}@` },
  {
    pattern: /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^\s"',;]{6,}\3/gi,
    replace: `$1$2$3${REDACTED}$3`,
  },
];

/**
 * Replace every credential-shaped run in `text` with `[REDACTED]`. Returns the
 * redacted text and how many runs were replaced. Over-redaction is the chosen
 * failure mode: `token_budget=120000` loses its number, a leaked key never
 * survives. Total and side-effect free.
 */
export function redactSecretText(text: string): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const { pattern, replace } of SECRET_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (...args: unknown[]) => {
      redactions++;
      const groups = args.slice(1, -2) as Array<string | undefined>;
      return replace.replace(/\$(\d)/g, (_m, d: string) => groups[Number(d) - 1] ?? '');
    });
  }
  return { text: out, redactions };
}
