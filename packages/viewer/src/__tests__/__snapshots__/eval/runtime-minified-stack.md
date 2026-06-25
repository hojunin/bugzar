# Bug report — TypeError: Cannot read properties of null (reading 'total')
URL: https://app.example/checkout
Session: 4.0s

## Errors (1)
- TypeError: Cannot read properties of null (reading 'total')
    TypeError: Cannot read properties of null (reading 'total')
    at t (https://app.example/assets/app.4f3a.js:1:88421)
    at o (https://app.example/assets/app.4f3a.js:1:90233)
    source: https://app.example/assets/app.4f3a.js:1:88421

## Reproduction
1. Click [button "Place order" — [data-testid="place-order"]]
2. Observed: TypeError: Cannot read properties of null (reading 'total')

## Where to look
- last action: Click [button "Place order" — [data-testid="place-order"]]

## Environment
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 · 1440×900