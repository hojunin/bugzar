import * as React from 'react';

import type { Product } from './api';

// Cart state persisted to localStorage. Bugzar snapshots storage on record, so
// the running cart shows up in the captured bundle — a realistic "what was the
// user's state when the bug happened" signal.

export interface CartLine {
  id: number;
  title: string;
  price: number;
  thumbnail: string;
  qty: number;
}

const KEY = 'bugzar.cart';

function read(): CartLine[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CartLine[]) : [];
  } catch {
    return [];
  }
}

export function useCart() {
  const [lines, setLines] = React.useState<CartLine[]>(read);

  React.useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(lines));
  }, [lines]);

  const add = React.useCallback((product: Product, qty = 1) => {
    setLines((prev) => {
      const existing = prev.find((l) => l.id === product.id);
      if (existing) {
        return prev.map((l) => (l.id === product.id ? { ...l, qty: l.qty + qty } : l));
      }
      return [
        ...prev,
        {
          id: product.id,
          title: product.title,
          price: product.price,
          thumbnail: product.thumbnail,
          qty,
        },
      ];
    });
  }, []);

  const setQty = React.useCallback((id: number, qty: number) => {
    setLines((prev) =>
      qty <= 0
        ? prev.filter((l) => l.id !== id)
        : prev.map((l) => (l.id === id ? { ...l, qty } : l)),
    );
  }, []);

  const remove = React.useCallback((id: number) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const clear = React.useCallback(() => setLines([]), []);

  const count = lines.reduce((n, l) => n + l.qty, 0);
  const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);

  return { lines, add, setQty, remove, clear, count, total };
}

export type Cart = ReturnType<typeof useCart>;
