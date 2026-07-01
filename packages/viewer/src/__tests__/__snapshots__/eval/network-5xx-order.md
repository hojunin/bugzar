# Bug report — POST /api/order → 500
URL: https://app.example/checkout
Session: 4.0s

## Failing request (1)
**POST /api/order → 500** (50ms)
Request:
```
{"sku":"WIDGET-1","qty":3,"coupon":"SAVE10"}
```
Response:
```
{"error":"OUT_OF_STOCK","detail":"sku WIDGET-1 has 0 available","traceId":"abc123"}
```

## Reproduction
1. Click [button "Place order" — [data-testid="place-order"]]
2. Observed: POST /api/order → 500

## Where to look
- failing endpoint: POST /api/order → 500
- last action: Click [button "Place order" — [data-testid="place-order"]]

## Environment
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 · 1440×900