import { sanitizeDiagnostic } from '../shared/diagnostics';

/** Metadata, not process output or resource bodies. No domain-specific field names. */
export function evidenceMetadata(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const omitted =
    /^(stdout|stderr|body|content|text|args|arguments|input|payload|prompt|reasoning|delta)$/i;
  function visit(value: unknown, depth: number): unknown {
    if (depth > 3) return undefined;
    if (typeof value === 'string') return value.slice(0, 256);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => visit(item, depth + 1));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !omitted.test(key))
          .slice(0, 16)
          .map(([key, item]) => [key, visit(item, depth + 1)])
          .filter(([, item]) => item !== undefined),
      );
    return undefined;
  }
  const safe = visit(sanitizeDiagnostic(value), 0) ?? null;
  return Buffer.byteLength(JSON.stringify(safe)) <= 4096 ? safe : { truncated: true };
}
