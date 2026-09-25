import { getCurrentWindow } from '@tauri-apps/api/window';

// Resolved on use, not at import: getCurrentWindow() reads
// window.__TAURI_INTERNALS__.metadata, which does not exist in a browser, so
// evaluating it at module scope would break the bundle for web access.
const win = () => getCurrentWindow();

export function WindowControls() {
  return (
    <div className="no-drag pointer-events-auto group flex items-center gap-2">
      <button
        onClick={() => win().close()}
        aria-label="Close"
        title="Close"
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#FF5F57]"
      >
        <svg viewBox="0 0 8 8" className="h-2 w-2 opacity-0 group-hover:opacity-100">
          <path
            d="M1.5 1.5L6.5 6.5M6.5 1.5L1.5 6.5"
            stroke="#5A0E0C"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        onClick={() => win().minimize()}
        aria-label="Minimize"
        title="Minimize"
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#FEBC2E]"
      >
        <svg viewBox="0 0 8 8" className="h-2 w-2 opacity-0 group-hover:opacity-100">
          <path d="M1.5 4H6.5" stroke="#985712" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      </button>
      <button
        onClick={() => win().toggleMaximize()}
        aria-label="Maximize"
        title="Maximize"
        className="flex h-3 w-3 items-center justify-center rounded-full bg-[#28C840]"
      >
        <svg viewBox="0 0 8 8" className="h-2 w-2 opacity-0 group-hover:opacity-100">
          <path
            d="M1.5 6.5L6.5 1.5M3 1.5H6.5V5"
            stroke="#0C5B1E"
            strokeWidth="1.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}
