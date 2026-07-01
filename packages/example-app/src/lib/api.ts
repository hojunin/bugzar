// Thin client over DummyJSON (https://dummyjson.com) — a free, key-less, CORS-enabled
// e-commerce API. Every call here is a real fetch, so Bugzar's network capture records
// genuine request/response bodies, statuses, and timings.

const BASE = 'https://dummyjson.com';

export interface Product {
  id: number;
  title: string;
  description: string;
  category: string;
  price: number;
  discountPercentage: number;
  rating: number;
  stock: number;
  brand?: string;
  tags: string[];
  thumbnail: string;
  images: string[];
  availabilityStatus?: string;
  shippingInformation?: string;
  warrantyInformation?: string;
  returnPolicy?: string;
  reviews?: Review[];
}

export interface Review {
  rating: number;
  comment: string;
  reviewerName: string;
  date: string;
}

export interface Category {
  slug: string;
  name: string;
}

export interface ProductPage {
  products: Product[];
  total: number;
  skip: number;
  limit: number;
}

export type SortKey = 'featured' | 'price-asc' | 'price-desc' | 'rating-desc';

const SORT_PARAMS: Record<SortKey, string> = {
  featured: '',
  'price-asc': '&sortBy=price&order=asc',
  'price-desc': '&sortBy=price&order=desc',
  'rating-desc': '&sortBy=rating&order=desc',
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Request failed: ${init?.method ?? 'GET'} ${url} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const PAGE_SIZE = 12;

export function fetchProducts(params: {
  page: number;
  category: string | null;
  query: string;
  sort: SortKey;
}): Promise<ProductPage> {
  const { page, category, query, sort } = params;
  const skip = page * PAGE_SIZE;
  const sortPart = SORT_PARAMS[sort];

  if (query.trim()) {
    return json<ProductPage>(
      `${BASE}/products/search?q=${encodeURIComponent(query.trim())}&limit=${PAGE_SIZE}&skip=${skip}${sortPart}`,
    );
  }
  if (category) {
    return json<ProductPage>(
      `${BASE}/products/category/${category}?limit=${PAGE_SIZE}&skip=${skip}${sortPart}`,
    );
  }
  return json<ProductPage>(`${BASE}/products?limit=${PAGE_SIZE}&skip=${skip}${sortPart}`);
}

export function fetchCategories(): Promise<Category[]> {
  return json<Category[]>(`${BASE}/products/categories`);
}

export function fetchProduct(id: number): Promise<Product> {
  return json<Product>(`${BASE}/products/${id}`);
}

export interface AuthResult {
  id: number;
  firstName: string;
  lastName: string;
  image: string;
  email: string;
}

export function login(username: string, password: string): Promise<AuthResult> {
  return json<AuthResult>(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, expiresInMins: 30 }),
  });
}

// Intentionally hits an endpoint that returns 500 with a JSON error body — the
// "report a bug" scenario. The real failing request + thrown error are exactly
// what a Bugzar recording is meant to capture.
export async function submitCheckout(payload: {
  items: { id: number; title: string; qty: number }[];
  total: number;
}): Promise<never> {
  const res = await fetch(`${BASE}/http/500`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, idempotencyKey: `chk_${payload.total}` }),
  });
  const body = await res.json().catch(() => ({}));
  throw new Error(
    `Checkout failed (${res.status}): ${(body as { message?: string }).message ?? 'gateway error'}`,
  );
}
