import { Checkbox } from '../ui/Checkbox';
import { formatFileSize } from '../../utils/formatters';
import type { LeftoverCategory, LeftoverItem, LeftoverReport } from '../../types';

const CATEGORY_ORDER: LeftoverCategory[] = [
  'binary',
  'sibling',
  'presets',
  'appSupport',
  'prefs',
  'caches',
  'documents',
  'icloud',
  'registry',
];

const CATEGORY_LABELS: Record<LeftoverCategory, string> = {
  binary: 'Plugin',
  sibling: 'Other formats of this plugin',
  presets: 'Presets',
  appSupport: 'Application data',
  prefs: 'Preferences',
  caches: 'Caches & saved state',
  documents: 'Documents & Music folders',
  icloud: 'iCloud Drive',
  registry: 'Windows Registry',
};

interface LeftoverChecklistProps {
  report: LeftoverReport;
  selections: Record<string, boolean>;
  onToggle: (path: string, checked: boolean) => void;
}

export function LeftoverChecklist({ report, selections, onToggle }: LeftoverChecklistProps) {
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    items: report.items.filter((i) => i.category === category),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex max-h-[40vh] flex-col gap-4 overflow-y-auto pr-1">
      {groups.map(({ category, items }) => (
        <div key={category} className="flex flex-col gap-1.5">
          <div className="text-[10px] uppercase tracking-widest text-gray-500">
            {CATEGORY_LABELS[category]}
          </div>
          {items.map((item) => (
            <LeftoverRow
              key={item.path}
              item={item}
              vendor={report.vendor}
              checked={selections[item.path] ?? false}
              onToggle={onToggle}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function LeftoverRow({
  item,
  vendor,
  checked,
  onToggle,
}: {
  item: LeftoverItem;
  vendor: string | null;
  checked: boolean;
  onToggle: (path: string, checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-gray-800/50">
      <Checkbox
        checked={checked}
        onChange={(c) => onToggle(item.path, c)}
        aria-label={item.path}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="mono truncate text-[11px] text-gray-300" title={item.path}>
          {item.path}
        </div>
        {item.shared && (
          <div className="text-[11px] text-gray-500">
            Shared with other {vendor ?? 'vendor'} plugins — left unchecked by default
          </div>
        )}
      </div>
      {item.confidence === 'vendor' && !item.shared && (
        <span className="shrink-0 rounded border border-gray-700 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-gray-500">
          vendor
        </span>
      )}
      <span className="mono shrink-0 text-[11px] text-gray-500">
        {item.isRegistryKey ? 'reg key' : formatFileSize(item.sizeBytes)}
      </span>
    </div>
  );
}
