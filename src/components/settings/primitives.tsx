// Shared layout primitives for the Settings page and the section components
// that live alongside it.

export function SettingSection({ title, description, children }: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-4 border-b border-gray-700/60 pb-3">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">{title}</h3>
        {description && <p className="mt-1 text-xs text-gray-600">{description}</p>}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

export function SettingRow({ label, description, children }: {
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-lg px-3 py-3 hover:bg-gray-800/50 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-stack-white">{label}</p>
        {description && <div className="mt-0.5 text-xs text-gray-500">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? 'bg-stack-fire' : 'bg-gray-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
