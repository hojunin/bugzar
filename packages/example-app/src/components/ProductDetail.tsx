import { Loader2, Minus, Plus, ShieldCheck, Star, Truck, Undo2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchProduct, type Product } from '@/lib/api';

interface Props {
  productId: number | null;
  preview: Product | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (product: Product, qty: number) => void;
}

export function ProductDetail({ productId, preview, open, onOpenChange, onAdd }: Props) {
  const [full, setFull] = React.useState<Product | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [activeImage, setActiveImage] = React.useState(0);
  const [qty, setQty] = React.useState(1);

  React.useEffect(() => {
    if (!open || productId == null) return;
    setFull(null);
    setActiveImage(0);
    setQty(1);
    setLoading(true);
    fetchProduct(productId)
      .then(setFull)
      .catch((err) => console.error('[storefront] product detail failed', err))
      .finally(() => setLoading(false));
  }, [open, productId]);

  const product = full ?? preview;
  const images = product?.images?.length ? product.images : product ? [product.thumbnail] : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0">
        {product ? (
          <div className="grid gap-0 md:grid-cols-2">
            <div className="flex flex-col gap-3 bg-muted/40 p-6">
              <div className="aspect-square overflow-hidden rounded-xl bg-muted">
                <img
                  src={images[activeImage]}
                  alt={product.title}
                  className="size-full object-cover"
                />
              </div>
              {images.length > 1 && (
                <div className="flex gap-2 overflow-x-auto">
                  {images.map((src, i) => (
                    <button
                      type="button"
                      key={src}
                      onClick={() => setActiveImage(i)}
                      className={`size-16 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                        i === activeImage
                          ? 'border-primary'
                          : 'border-transparent opacity-70 hover:opacity-100'
                      }`}
                    >
                      <img src={src} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4 p-7">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {product.category}
                  </Badge>
                  <span className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Star className="size-4 fill-amber-400 text-amber-400" />
                    {product.rating.toFixed(1)}
                  </span>
                </div>
                <DialogTitle>{product.title}</DialogTitle>
                <DialogDescription className="line-clamp-3">
                  {product.description}
                </DialogDescription>
              </div>

              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold tracking-tight">
                  ${(product.price * (1 - product.discountPercentage / 100)).toFixed(2)}
                </span>
                {product.discountPercentage >= 1 && (
                  <span className="text-base text-muted-foreground line-through">
                    ${product.price.toFixed(2)}
                  </span>
                )}
              </div>

              {loading && (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              )}

              {full && (
                <div className="grid grid-cols-1 gap-2 text-sm text-muted-foreground">
                  {full.shippingInformation && (
                    <span className="flex items-center gap-2">
                      <Truck className="size-4" /> {full.shippingInformation}
                    </span>
                  )}
                  {full.warrantyInformation && (
                    <span className="flex items-center gap-2">
                      <ShieldCheck className="size-4" /> {full.warrantyInformation}
                    </span>
                  )}
                  {full.returnPolicy && (
                    <span className="flex items-center gap-2">
                      <Undo2 className="size-4" /> {full.returnPolicy}
                    </span>
                  )}
                </div>
              )}

              <Separator />

              <div className="mt-auto flex items-center gap-3">
                <div className="flex items-center rounded-md border">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setQty((q) => Math.max(1, q - 1))}
                    aria-label="Decrease quantity"
                  >
                    <Minus />
                  </Button>
                  <span className="w-9 text-center text-sm font-semibold tabular-nums">{qty}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setQty((q) => q + 1)}
                    aria-label="Increase quantity"
                  >
                    <Plus />
                  </Button>
                </div>
                <Button
                  size="lg"
                  className="flex-1"
                  onClick={() => {
                    onAdd(product, qty);
                    onOpenChange(false);
                  }}
                >
                  Add {qty} to cart
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-72 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
