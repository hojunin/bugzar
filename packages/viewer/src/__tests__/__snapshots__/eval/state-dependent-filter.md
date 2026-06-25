# Bug report — TypeError: filters.map is not a function
URL: https://app.example/checkout
Session: 4.0s

## Errors (1)
- TypeError: filters.map is not a function
    TypeError: filters.map is not a function
    at FilterList (FilterList.tsx:28:18)

## Reproduction
1. Click [button "Place order" — [data-testid="place-order"]]
2. Observed: TypeError: filters.map is not a function

## Where to look
- error origin (observed): at FilterList (FilterList.tsx:28:18)
- last action: Click [button "Place order" — [data-testid="place-order"]]

## Environment
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 · 1440×900