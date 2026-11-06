import './ProcessingLabel.css';

/** A stationary, readable label with a compositor-only opacity wave while work is active. */
export function ProcessingLabel({ text, active = true }: { text: string; active?: boolean }) {
  return (
    <span className="processing-label" data-active={active}>
      <span>{text}</span>
      {active && (
        <span className="processing-label-wave" aria-hidden="true">
          {Array.from(text).map((character, index) => (
            <span
              key={index}
              className="processing-label-glyph"
              style={{ animationDelay: `${index * 80 - 2000}ms` }}
            >
              {character}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
