export interface SessionDraft {
  readonly text: string;
}

/** Unsent UI text only. The empty key owns the not-yet-created conversation. */
export class SessionDrafts {
  private entries = new Map<string, SessionDraft>();

  read(id: string) {
    return this.entries.get(id)?.text ?? '';
  }

  capture(id: string) {
    return this.entries.get(id);
  }

  set(id: string, text: string) {
    if (!text) this.entries.delete(id);
    else this.entries.set(id, { text });
  }

  /** Transfer ownership when Corax assigns a new session ID; preserve edit identity. */
  attach(id: string, draft = this.entries.get('')) {
    if (!id || !draft || this.entries.has(id)) return;
    this.entries.set(id, draft);
    if (this.entries.get('') === draft) this.entries.delete('');
  }

  /** A receipt cannot erase later edits, even edits that returned to the same text. */
  accepted(id: string, submitted: SessionDraft | undefined, content: string) {
    if (
      !submitted ||
      submitted.text.trim() !== content.trim() ||
      this.entries.get(id) !== submitted
    )
      return false;
    this.entries.delete(id);
    return true;
  }
}
