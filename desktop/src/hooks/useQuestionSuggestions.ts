import { useEffect, useRef, useState } from 'react';
import type { QuestionSuggestions } from '@auto-agent/desktop-protocol';
import { api, type Session } from '../bridge';

interface CachedSuggestions {
  identity: number;
  value: QuestionSuggestions;
}

/** One display result for this App lifetime; never persisted or shared across data identities. */
export function useQuestionSuggestions(
  active: boolean,
  connected: boolean,
  sessions: readonly Session[],
  identity: number,
) {
  const usageRevision = sessions
    .slice(0, 3)
    .map(({ id, title, updatedAt }) => `${id}:${updatedAt}:${title}`)
    .join('|');
  const [result, setResult] = useState<CachedSuggestions | null>(null);
  const [loading, setLoading] = useState(false);
  const cache = useRef<CachedSuggestions | null>(null);
  const attempted = useRef<number | null>(null);
  const request = useRef(0);
  const currentIdentity = useRef(identity);
  const mounted = useRef(false);
  currentIdentity.current = identity;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    if (!connected) {
      request.current++;
      cache.current = null;
      attempted.current = null;
      setResult(null);
      setLoading(false);
      return;
    }
    // Warm once after connection, including when an existing conversation opens.
    // Later usage changes refresh only while the welcome page is visible.
    if (!active && attempted.current === identity) return;
    const sequence = ++request.current;
    const current = () =>
      mounted.current && request.current === sequence && currentIdentity.current === identity;
    const publish = (value: QuestionSuggestions) => {
      if (!current()) return;
      const previous = cache.current?.identity === identity ? cache.current.value : null;
      const next = {
        identity,
        value:
          value.source === 'model' && value.questions.length === 4 ? value : (previous ?? value),
      };
      cache.current = next;
      setResult(next);
    };
    const timer = setTimeout(() => {
      attempted.current = identity;
      setLoading(true);
      void api<QuestionSuggestions>('/suggestions', 'POST', {})
        .then(publish)
        .catch(() => publish({ questions: [], source: 'default' }))
        .finally(() => {
          if (current()) setLoading(false);
        });
    }, 350);
    // Leaving the welcome page may finish a useful warm-up. A newer request,
    // reconnect or configuration boundary makes that response ineligible.
    return () => clearTimeout(timer);
  }, [active, connected, identity, usageRevision]);
  return {
    suggestions: connected && result?.identity === identity ? result.value : null,
    loading: connected && loading,
  };
}
