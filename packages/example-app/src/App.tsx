import { Bugzar } from '@bugzar/sdk';
import { Loader2, PackageOpen, SlidersHorizontal } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { CartSheet } from '@/components/CartSheet';
import { CategoryBar } from '@/components/CategoryBar';
import { Header } from '@/components/Header';
import { LoginDialog } from '@/components/LoginDialog';
import { ProductCard } from '@/components/ProductCard';
import { ProductDetail } from '@/components/ProductDetail';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import {
  type AuthResult,
  type Category,
  fetchCategories,
  fetchProducts,
  PAGE_SIZE,
  type Product,
  type SortKey,
} from '@/lib/api';
import { useCart } from '@/lib/cart';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
  { value: 'rating-desc', label: 'Top rated' },
];

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function App() {
  const cart = useCart();

  const [categories, setCategories] = React.useState<Category[]>([]);
  const [category, setCategory] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebounced(query, 350);
  const [sort, setSort] = React.useState<SortKey>('featured');

  const [products, setProducts] = React.useState<Product[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [detailProduct, setDetailProduct] = React.useState<Product | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [cartOpen, setCartOpen] = React.useState(false);
  const [loginOpen, setLoginOpen] = React.useState(false);
  const [user, setUser] = React.useState<AuthResult | null>(null);

  // Categories — once.
  React.useEffect(() => {
    fetchCategories()
      .then(setCategories)
      .catch((err) => console.error('[storefront] categories failed', err));
  }, []);

  // Reset to first page whenever the filter set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these deps are the intended reset triggers
  React.useEffect(() => {
    setPage(0);
  }, [category, debouncedQuery, sort]);

  // Fetch products for the current filter + page.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProducts({ page, category, query: debouncedQuery, sort })
      .then((res) => {
        if (cancelled) return;
        setTotal(res.total);
        setProducts((prev) => (page === 0 ? res.products : [...prev, ...res.products]));
      })
      .catch((err: Error) => {
        if (cancelled) return;
        console.error('[storefront] product list failed', err);
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, category, debouncedQuery, sort]);

  const addToCart = React.useCallback(
    (product: Product, qty = 1) => {
      cart.add(product, qty);
      toast.success(`Added to cart`, { description: product.title });
    },
    [cart],
  );

  const openDetail = (product: Product) => {
    setDetailProduct(product);
    setDetailOpen(true);
  };

  const hasMore = products.length < total;
  const initialLoading = loading && page === 0;

  return (
    <div className="min-h-screen bg-background">
      <Header
        query={query}
        onQuery={setQuery}
        cartCount={cart.count}
        onCartClick={() => setCartOpen(true)}
        user={user}
        onLoginClick={() => setLoginOpen(true)}
      />

      {/* Hero */}
      <section className="border-b bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-primary">
            New season
          </p>
          <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
            Everything you need, curated in one place.
          </h1>
          <p className="mt-4 max-w-xl text-lg text-muted-foreground">
            A demo storefront powered by the DummyJSON API — and instrumented with{' '}
            <span className="font-semibold text-foreground">Bugzar</span>. Browse, search, and check
            out, then hit the floating QA button to record a session.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <CategoryBar categories={categories} active={category} onSelect={setCategory} />
          <div className="flex shrink-0 items-center gap-2">
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {error ? (
          <EmptyState
            title="Something went wrong"
            body={error}
            action={
              <Button onClick={() => setPage(0)} variant="outline">
                Retry
              </Button>
            }
          />
        ) : initialLoading ? (
          <ProductGridSkeleton />
        ) : products.length === 0 ? (
          <EmptyState
            title="No products found"
            body={
              debouncedQuery ? `No matches for “${debouncedQuery}”.` : 'Try a different category.'
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
              {products.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  onOpen={openDetail}
                  onAdd={(prod) => addToCart(prod)}
                />
              ))}
            </div>

            {hasMore && (
              <div className="mt-10 flex justify-center">
                <Button
                  size="lg"
                  variant="outline"
                  disabled={loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {loading ? <Loader2 className="animate-spin" /> : null}
                  {loading ? 'Loading…' : 'Load more products'}
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="mt-12 border-t">
        <div className="mx-auto max-w-7xl px-4 py-8 text-sm text-muted-foreground sm:px-6 lg:px-8">
          Bugzar is a fictional demo store. Data from{' '}
          <a
            href="https://dummyjson.com"
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            DummyJSON
          </a>
          . Recording by Bugzar.
        </div>
      </footer>

      <ProductDetail
        productId={detailProduct?.id ?? null}
        preview={detailProduct}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onAdd={addToCart}
      />
      <CartSheet cart={cart} open={cartOpen} onOpenChange={setCartOpen} />
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} onAuthed={setUser} />

      <Toaster />

      <Bugzar
        autoHide
        endpoint={'https://bugzar-backend.hjinn.workers.dev'}
        jira={{ clientId: 'iKR0gISeJRmq8BsTcihAmlOsIzAQoDkQ' }}
        onExport={async (blob, meta) => {
          const res = await fetch(
            `https://bugzar-backend.hjinn.workers.dev/pilot/r2/${meta.mode}-${meta.startedAt}.html`,
            {
              method: 'PUT',
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: blob,
            },
          );
          const { url } = (await res.json()) as { url: string };
          return url;
        }}
      />
    </div>
  );
}

function ProductGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: PAGE_SIZE }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <div key={i} className="flex flex-col gap-3 rounded-xl border p-0">
          <Skeleton className="aspect-square w-full rounded-b-none" />
          <div className="flex flex-col gap-2 p-5 pt-0">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-6 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed py-20 text-center">
      <PackageOpen className="size-12 text-muted-foreground/50" />
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}
