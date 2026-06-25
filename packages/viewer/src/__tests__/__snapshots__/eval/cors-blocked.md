# Bug report — Access to fetch at 'https://api.thirdparty.com/v1/quote' from origin 'https://app.example' has been blocked by CORS policy
URL: https://app.example/checkout
Session: 4.0s

## Failing request (1)
**GET /v1/quote → Failed to fetch** (50ms)
Transport error: Failed to fetch
likely CORS — opaque fetch failure (status 0, no body); check server CORS / proxy

## Errors (1)
- Access to fetch at 'https://api.thirdparty.com/v1/quote' from origin 'https://app.example' has been blocked by CORS policy

## Reproduction
1. Click [button "Place order" — [data-testid="place-order"]]
2. Observed: Access to fetch at 'https://api.thirdparty.com/v1/quote' from origin 'https://app.example' has been blocked by CORS policy

## Where to look
- last action: Click [button "Place order" — [data-testid="place-order"]]

## Environment
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 · 1440×900