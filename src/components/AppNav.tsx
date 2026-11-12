import { Images, MessageCircle } from 'lucide-react';

export type AppView = 'photos' | 'whatsapp';

interface NavItem {
  readonly id: AppView;
  readonly label: string;
  readonly shortLabel: string;
  readonly icon: typeof Images;
}

const ITEMS: readonly NavItem[] = [
  { id: 'photos', label: 'Photos', shortLabel: 'Photos', icon: Images },
  { id: 'whatsapp', label: 'WhatsApp Vault', shortLabel: 'WhatsApp', icon: MessageCircle },
];

export interface AppNavProps {
  readonly view: AppView;
  readonly onChange: (view: AppView) => void;
}

/**
 * Google Photos-style navigation rail on desktop, tab bar on mobile.
 * The rail is intentionally quiet so the gallery keeps the visual weight.
 */
export function AppNav({ view, onChange }: AppNavProps) {
  return (
    <>
      <aside
        aria-label="Sections"
        className="sticky top-[57px] hidden h-[calc(100dvh-57px)] w-[72px] shrink-0 flex-col gap-1 border-r border-line bg-app px-2 py-3 md:flex xl:w-56 xl:px-3"
      >
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center justify-center gap-3 rounded-full px-3 py-2.5 text-sm font-medium transition-colors xl:justify-start ${
                active
                  ? 'bg-accent-soft text-accent'
                  : 'text-muted hover:bg-surface hover:text-ink'
              }`}
            >
              <Icon size={20} />
              <span className="hidden xl:inline">{item.label}</span>
            </button>
          );
        })}

        <div className="mt-auto hidden px-3 pb-2 xl:block">
          <p className="text-[11px] leading-relaxed text-muted">
            Your files live in your own Telegram channels. Nothing is proxied.
          </p>
        </div>
      </aside>

      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-app/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
      >
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-medium ${
                active ? 'text-accent' : 'text-muted'
              }`}
            >
              <Icon size={21} />
              {item.shortLabel}
            </button>
          );
        })}
      </nav>
    </>
  );
}
