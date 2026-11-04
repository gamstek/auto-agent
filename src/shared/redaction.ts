/** Redact complete text and retain secret prefixes split across stream chunks. */
export function createRedactor(secrets: () => readonly string[]) {
  return (text: string) => {
    for (const secret of secrets()) if (secret) text = text.split(secret).join('[redacted]');
    return text;
  };
}
export function redactedStream(options: {
  secrets: readonly string[];
  redact: (text: string) => string;
  emit: (text: string) => void;
  aborted: () => boolean;
}) {
  let pending = '',
    emitted = false;
  const flush = (final = false) => {
    if (options.aborted()) return;
    let retain = 0;
    if (!final)
      for (const secret of options.secrets)
        for (let size = 1; size < secret.length; size++)
          if (pending.endsWith(secret.slice(0, size))) retain = Math.max(retain, size);
    const safe = pending.slice(0, pending.length - retain);
    pending = retain ? pending.slice(-retain) : '';
    if (safe) {
      emitted = true;
      options.emit(safe);
    }
  };
  return {
    write(text: string) {
      if (!options.aborted()) {
        pending = options.redact(pending + text);
        flush();
      }
    },
    flush,
    hasEmitted: () => emitted,
  };
}
