import { Plus, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Product } from '@/lib/api';

interface Props {
  product: Product;
  onOpen: (product: Product) => void;
  onAdd: (product: Product) => void;
}

export function ProductCard({ product, onOpen, onAdd }: Props) {
  const discounted = product.price * (1 - product.discountPercentage / 100);
  const lowStock = product.stock <= 10;

  return (
    <Card className="group gap-0 overflow-hidden p-0 transition-all hover:-translate-y-1 hover:shadow-xl">
      <button
        type="button"
        onClick={() => onOpen(product)}
        className="relative block aspect-square w-full overflow-hidden bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        aria-label={`View ${product.title}`}
      >
        <img
          src={product.thumbnail}
          alt={product.title}
          loading="lazy"
          className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
        {product.discountPercentage >= 10 && (
          <Badge variant="destructive" className="absolute left-3 top-3 shadow-sm">
            −{Math.round(product.discountPercentage)}%
          </Badge>
        )}
        {lowStock && (
          <Badge variant="secondary" className="absolute right-3 top-3 shadow-sm">
            Only {product.stock} left
          </Badge>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {product.brand ?? product.category}
          </p>
          <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Star className="size-3.5 fill-amber-400 text-amber-400" />
            {product.rating.toFixed(1)}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onOpen(product)}
          className="line-clamp-2 text-left text-[15px] font-semibold leading-snug outline-none hover:text-primary focus-visible:text-primary"
        >
          {product.title}
        </button>

        <div className="mt-auto flex items-end justify-between gap-3 pt-1">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold tracking-tight">${discounted.toFixed(2)}</span>
            {product.discountPercentage >= 1 && (
              <span className="text-sm text-muted-foreground line-through">
                ${product.price.toFixed(2)}
              </span>
            )}
          </div>
          <Button
            size="icon-sm"
            onClick={() => onAdd(product)}
            aria-label={`Add ${product.title} to cart`}
          >
            <Plus />
          </Button>
        </div>
      </div>
    </Card>
  );
}
