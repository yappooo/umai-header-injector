# UMAI Venue API Header Injector

A Chrome extension for the UMAI restaurant booking widget. Three buttons,
that's it:

1. **Save a key** — paste a venue key, click save, done.
2. **Harvest** — don't have a key? Click this, it grabs one automatically.
3. **Hunt** — auto-fills the booking flow for you and stops right before
   payment so you pay manually.

![popup](screenshots/popup.png)

## Install (2 minutes)

1. Open Chrome, go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Pick this folder (`umai-header-injector`).
5. Done — the icon shows up in your toolbar.

## How to use

### Get a key automatically (easiest)

1. Click the extension icon.
2. Click **HARVEST LATEST KEY**.
3. A new tab opens by itself, waits for the page to load, grabs the key.
4. Click **USE THIS KEY** when it shows up.

### Or paste a key yourself

1. Click the extension icon.
2. Paste your venue key into the box.
3. Click **SAVE & ACTIVATE**.

### Auto-book a table

1. Click **Configure hunt...** in the popup.
2. Fill in: date you want, party size, earliest/latest time you'll accept,
   your name/email/phone.
3. Go back to the popup, click **START HUNT**.
4. It opens the booking page, waits for any Cloudflare check to clear,
   keeps checking for a free slot in your time window, clicks it the
   second one shows up, fills your contact info, and takes you to the
   payment page.
5. **You pay the card yourself** — this never touches or stores card
   details.
6. Watch the small log box in the popup to see what it's doing at each
   step. Click **STOP HUNT** any time to cancel.

## Why does it need these Chrome permissions?

- Reads/changes requests only on `umai.io` and `letsumai.com` — nothing
  else on the internet.
- Needs to open/control one tab to run Harvest/Hunt.
- Needs notification permission to ping you when a table is booked.

## Files (only if you're editing this)

| File | What it does |
|---|---|
| `manifest.json` | Chrome extension config |
| `background.js` | Keeps your key applied, runs Harvest |
| `hunt.js` | Runs the auto-booking flow |
| `popup.html` / `popup.js` | The popup window |
| `options.html` / `options.js` | The Hunt settings page |
