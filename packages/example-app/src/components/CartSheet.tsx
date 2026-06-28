import { Loader2, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { submitCheckout } from '@/lib/api';
import type { Cart } from '@/lib/cart';

interface Props {
  cart: Cart;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CartSheet({ cart, open, onOpenChange }: Props) {
  const [checkingOut, setCheckingOut] = React.useState(false);

  async function checkout() {
    setCheckingOut(true);
    try {
      // Hits a gateway that intentionally 500s — the canonical "report a bug"
      // moment. The failed request + console error land in the Bugzar bundle.
      await submitCheckout({
        items: cart.lines.map((l) => ({ id: l.id, title: l.title, qty: l.qty })),
        total: cart.total,
      });
    } catch (err) {
      console.error('[storefront] checkout failed', err);
      toast.error('Checkout failed — payment gateway returned 500.', {
        description: 'Hit the QA button (bottom-right) to record a repro for this bug.',
      });
    } finally {
      setCheckingOut(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingBag className="size-5" /> Your cart
          </SheetTitle>
          <SheetDescription>
            {cart.count > 0
              ? `${cart.count} item${cart.count > 1 ? 's' : ''} ready to check out`
              : 'Your cart is empty'}
          </SheetDescription>
        </SheetHeader>

        {cart.lines.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
            <ShoppingBag className="size-10 opacity-40" />
            <p className="text-sm">Add a few products and they will show up here.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <ul className="flex flex-col gap-5">
              {cart.lines.map((line) => (
                <li key={line.id} className="flex gap-4">
                  <div className="size-20 shrink-0 overflow-hidden rounded-lg border bg-muted">
                    <img src={line.thumbnail} alt={line.title} className="size-full object-cover" />
                  </div>
                  <div className="flex flex-1 flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-sm font-medium leading-snug">{line.title}</p>
                      <button
                        type="button"
                        onClick={() => cart.remove(line.id)}
                        className="text-muted-foreground transition-colors hover:text-destructive"
                        aria-label={`Remove ${line.title}`}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                    <div className="mt-auto flex items-center justify-between">
                      <div className="flex items-center rounded-md border">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => cart.setQty(line.id, line.qty - 1)}
                          aria-label="Decrease quantity"
                        >
                          <Minus />
                        </Button>
                        <span className="w-8 text-center text-sm font-semibold tabular-nums">
                          {line.qty}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => cart.setQty(line.id, line.qty + 1)}
                          aria-label="Increase quantity"
                        >
                          <Plus />
                        </Button>
                      </div>
                      <span className="text-sm font-semibold tabular-nums">
                        ${(line.price * line.qty).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {cart.lines.length > 0 && (
          <SheetFooter>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Subtotal</span>
              <span className="text-base font-semibold text-foreground tabular-nums">
                ${cart.total.toFixed(2)}
              </span>
            </div>
            <Separator />
            <Button size="lg" className="w-full" onClick={checkout} disabled={checkingOut}>
              {checkingOut ? <Loader2 className="animate-spin" /> : null}
              {checkingOut ? 'Processing…' : 'Checkout'}
            </Button>
            <Button variant="ghost" size="sm" className="w-full" onClick={cart.clear}>
              Clear cart
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
