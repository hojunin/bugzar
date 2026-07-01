# @bugzar/example-app — Bugzar storefront

A modern demo storefront wired with [`<Bugzar />`](../sdk). It's a realistic QA-recording
playground: real product data, search, cart, login, and a checkout that intentionally fails —
exactly the kinds of interactions Bugzar is built to capture.

Built with **React 19 + Vite + Tailwind v4 + shadcn/ui**. Product data comes from
[DummyJSON](https://dummyjson.com) — a free, key-less, CORS-enabled e-commerce API, so every
request is a genuine network call that shows up in the captured bundle.

## Run it

```bash
pnpm install
pnpm --filter @bugzar/example-app dev   # → http://localhost:5274
```

## What it exercises (and why it's a good Bugzar demo)

| Flow                  | What you do                                            | What Bugzar captures                                        |
| --------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| **Browse / paginate** | Category pills, sort, "Load more"                      | `GET /products`, `/category/*` requests + DOM mutations     |
| **Search**            | Type in the search box (debounced)                     | `GET /products/search?q=` with real query/response bodies   |
| **Product detail**    | Open a card                                            | `GET /products/{id}` — gallery, reviews, shipping fields    |
| **Cart**              | Add / change qty / remove                              | `localStorage` snapshot (cart persists across reloads)      |
| **Login**             | Sign in (`emilys` / `emilyspass`, or a wrong password) | `POST /auth/login` — success **or** a real `400`            |
| **Checkout (bug!)**   | Click Checkout in the cart                             | `POST` that returns **500** + a thrown error in the console |

The **checkout failure** is the canonical "report a bug" moment: a failed request plus a console
error. Reproduce it, hit the floating **QA** button (bottom-right) to record, and the SDK's
`onExport` hands back a self-contained replay HTML — surfaced here as a toast with an **Open** link.

## How Bugzar is wired

See [`src/App.tsx`](src/App.tsx) — a single `<Bugzar />` at the app root:

```tsx
<Bugzar
  onStart={() => toast('Recording started')}
  onExport={async (blob, meta) => {
    const url = URL.createObjectURL(blob); // in a real app: upload + return public URL
    toast.success(`Replay ready (${meta.mode})`, {
      action: { label: 'Open', onClick: () => window.open(url) },
    });
    return url;
  }}
/>
```

> Difference from [`packages/sdk/example`](../sdk/example): that one is a minimal e2e/smoke harness
> against a Vite mock API. This app is the polished, real-API showcase.
