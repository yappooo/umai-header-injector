# UMAI Venue API Header Injector

Chrome MV3 extension. Port of the `venue-api-key` header-injection trick used
in [`BypassCloudflare.py`](../Complete%20Code/BypassCloudflare.py) — that
script ran a CDP-attached Playwright session and used `context.route()` to
stamp a `venue-api-key` header onto every UMAI request. This extension does
the same thing natively in Chrome, no CDP/Playwright process required.

## What it does

- Popup lets you paste a `venue-api-key`.
- Background service worker keeps one `declarativeNetRequest` dynamic rule
  alive that, on every request to `umai.io` / `letsumai.com`:
  - sets header `venue-api-key: <your key>`
  - sets `Origin: https://reservation.umai.io`
  - sets `Referer: https://reservation.umai.io/`
- Requests to `stripe.com` are excluded (`excludedRequestDomains`), so
  payment calls are never touched — same separation the Python script made
  with `is_umai and not is_stripe`.
- Key is persisted in `chrome.storage.local`; clearing the field disables
  injection (rule removed).

## Why declarativeNetRequest instead of webRequest

MV3 dropped blocking `webRequest`. `declarativeNetRequest`'s
`modifyHeaders` action is the supported replacement and runs in the
network layer before the request leaves Chrome — no content script or
page-context hook needed, and it survives Cloudflare's JS challenge since
it's not page-script-visible.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `umai-header-injector` folder.
3. Click the extension icon, paste your `venue-api-key`, **SAVE & ACTIVATE**.
4. Visit `https://reservation.umai.io/en/widget/<slug>` — requests now carry
   the header automatically.

## Scope

Targets `reservation.umai.io/en/widget/*` flows. Matches any host under
`umai.io` / `letsumai.com` per `host_permissions` in `manifest.json` — narrow
that list if you only need one venue's domain pattern.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions, host scope |
| `background.js` | builds/updates the single DNR rule from stored key |
| `popup.html` / `popup.js` | UI to set/clear the key |
