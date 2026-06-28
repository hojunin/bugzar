import type { Category } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  categories: Category[];
  active: string | null;
  onSelect: (slug: string | null) => void;
}

export function CategoryBar({ categories, active, onSelect }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      <Pill label="All" selected={active === null} onClick={() => onSelect(null)} />
      {categories.map((c) => (
        <Pill
          key={c.slug}
          label={c.name}
          selected={active === c.slug}
          onClick={() => onSelect(c.slug)}
        />
      ))}
    </div>
  );
}

function Pill({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}
