import './InstrumentIcon.css';

export function InstrumentIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="instrument-icon"
      data-icon="instrument"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="17" rx="2" />
      <rect x="6" y="6" width="7" height="4" rx="1" />
      <path d="M17 6.5h1M17 9.5h1M6 13v3a1 1 0 0 0 2 0v-3M11 13v3a1 1 0 0 0 2 0v-3M16 13v3a1 1 0 0 0 2 0v-3M6 20v1M18 20v1" />
    </svg>
  );
}
