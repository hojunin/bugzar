# Bug report — Unhandled promise rejection: Error: payment gateway timeout
URL: https://app.example/checkout
Session: 4.0s

## Failing request (1)
**POST /api/pay → Network timeout** (50ms)
Request:
```
{"amount":4200,"token":"tok_visa"}
```
Transport error: Network timeout

## Errors (1)
- Unhandled promise rejection: Error: payment gateway timeout
    Error: payment gateway timeout
    at PayButton.onClick (PayButton.tsx:41:9)

## Where to look
- error origin (observed): at PayButton.onClick (PayButton.tsx:41:9)

## Environment
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 · 1440×900