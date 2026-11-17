import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, X } from 'lucide-react';

export interface DateFilterProps {
  readonly from: string;
  readonly to: string;
  readonly onChange: (from: string, to: string) => void;
}

type Preset = 'all' | 'today' | '7d' | '30d' | 'year';

const isoDay = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const daysAgo = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return isoDay(date);
};

const shortDate = (value: string): string => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export function DateFilter({ from, to, onChange }: DateFilterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const applyPreset = (preset: Preset): void => {
    if (preset === 'all') {
      onChange('', '');
      setOpen(false);
      return;
    }
    if (preset === 'today') {
      const today = isoDay(new Date());
      onChange(today, today);
      setOpen(false);
      return;
    }
    if (preset === '7d') {
      onChange(daysAgo(6), isoDay(new Date()));
      setOpen(false);
      return;
    }
    if (preset === '30d') {
      onChange(daysAgo(29), isoDay(new Date()));
      setOpen(false);
      return;
    }
    const now = new Date();
    onChange(`${now.getFullYear()}-01-01`, isoDay(now));
    setOpen(false);
  };

  const active = Boolean(from || to);
  const label =
    from && to
      ? from === to
        ? shortDate(from)
        : `${shortDate(from)} – ${shortDate(to)}`
      : from
        ? `From ${shortDate(from)}`
        : to
          ? `Until ${shortDate(to)}`
          : 'All dates';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Filter by date"
        aria-expanded={open}
        className={`flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
          active
            ? 'border-accent/40 bg-accent-soft text-accent'
            : 'border-line bg-elevated text-muted hover:text-ink'
        }`}
      >
        <CalendarDays size={13} />
        <span className="hidden sm:inline">{label}</span>
        {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent sm:hidden" /> : null}
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="fixed inset-x-3 top-16 z-40 max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-2xl border border-line bg-elevated p-3 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-ink">Filter by date</p>
            {active ? (
              <button
                type="button"
                onClick={() => {
                  onChange('', '');
                  setOpen(false);
                }}
                className="flex items-center gap-1 text-[11px] font-medium text-muted hover:text-ink"
              >
                <X size={12} /> Clear
              </button>
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block min-w-0">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">
                From
              </span>
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => onChange(event.target.value, to)}
                className="h-9 w-full min-w-0 rounded-lg border border-line bg-app px-2 text-xs text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="block min-w-0">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">
                To
              </span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => onChange(from, event.target.value)}
                className="h-9 w-full min-w-0 rounded-lg border border-line bg-app px-2 text-xs text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {(
              [
                ['all', 'All time'],
                ['today', 'Today'],
                ['7d', '7 days'],
                ['30d', '30 days'],
                ['year', 'This year'],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                onClick={() => applyPreset(value)}
                className="rounded-full border border-line bg-surface/60 px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface hover:text-ink"
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
