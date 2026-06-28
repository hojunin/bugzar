import { Search, ShoppingBag, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AuthResult } from '@/lib/api';

interface Props {
  query: string;
  onQuery: (q: string) => void;
  cartCount: number;
  onCartClick: () => void;
  user: AuthResult | null;
  onLoginClick: () => void;
}

export function Header({ query, onQuery, cartCount, onCartClick, user, onLoginClick }: Props) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-lg">
      <div className="mx-auto flex h-18 max-w-7xl items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <a href="/" className="flex shrink-0 items-center gap-2 text-lg font-bold tracking-tight">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Sparkles className="size-5" />
          </span>
          <span className="hidden sm:inline">Bugzar</span>
        </a>

        <div className="relative mx-auto w-full max-w-xl">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search products…"
            className="pl-10"
            aria-label="Search products"
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {user ? (
            <button
              type="button"
              onClick={onLoginClick}
              className="flex items-center gap-2 rounded-full border p-1 pr-3 transition-colors hover:bg-accent"
            >
              <img src={user.image} alt="" className="size-8 rounded-full bg-muted object-cover" />
              <span className="hidden text-sm font-medium sm:inline">{user.firstName}</span>
            </button>
          ) : (
            <Button variant="outline" onClick={onLoginClick} className="hidden sm:inline-flex">
              Sign in
            </Button>
          )}

          <Button
            variant="outline"
            size="icon"
            onClick={onCartClick}
            className="relative"
            aria-label="Open cart"
          >
            <ShoppingBag />
            {cartCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground tabular-nums">
                {cartCount}
              </span>
            )}
          </Button>
        </div>
      </div>
    </header>
  );
}
