// Optional portable diagnostic channel. JSON stdout remains the command result.
export function skillLog(event, details = {}) {
  if (process.env.SKILL_LOG_STDERR !== '1') return;
  try {
    process.stderr.write(`[skill-log] ${JSON.stringify({ ...details, event })}\n`);
  } catch {
    /* Diagnostic delivery must not change an external operation's outcome. */
  }
}
