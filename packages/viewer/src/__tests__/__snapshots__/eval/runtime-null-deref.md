# Bug report — TypeError: Cannot read properties of undefined (reading 'name')
URL: https://app.example/checkout
Session: 4.0s

## Errors (1)
- TypeError: Cannot read properties of undefined (reading 'name')
    TypeError: Cannot read properties of undefined (reading 'name')
    at UserBadge (UserBadge.tsx:14:22)
    at renderWithHooks (react-dom.js:1:55)

## Reproduction
1. Click [button "Place order" — [data-testid="place-order"]]
2. Observed: TypeError: Cannot read properties of undefined (reading 'name')

## Where to look
- error origin (observed): at UserBadge (UserBadge.tsx:14:22)
- last action: Click [button "Place order" — [data-testid="place-order"]]

## Environment
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 · 1440×900