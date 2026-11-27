# PicPocket mobile (React Native + Expo)

Android app for the same encrypted Telegram vault, with the WhatsApp backup as
the main screen.

## Run it

```bash
cd mobile
npm install            # already installed in this workspace
npx expo start         # scan the QR with Expo Go for the UI
npx expo run:android   # development build (needed for nothing here, but useful)
npx tsc --noEmit       # typecheck
```

Android-only features (WhatsApp folder, restore) need a real Android phone:
the folder picker uses the Storage Access Framework.

## What is inside

- `src/app/` — Expo Router screens: `(tabs)/index` vault grid, `(tabs)/whatsapp`
  backup + restore, `(tabs)/settings`, plus the onboarding gate in `_layout`.
- `src/lib/crypto/` — vault keys and `TGP1` envelope, identical to the web app
  (PBKDF2-SHA256 600k, AES-256-GCM).
- `src/lib/telegram/` — mtcute core with a pure-JS crypto provider (noble +
  fflate) and an RN WebSocket transport; no WASM, no WebView.
- `src/lib/whatsapp/` — SAF folder scan, upload plan, manifest, restore.
- `src/lib/db.ts` — SQLite: settings, WhatsApp file index, backup bookkeeping.

## Known limits

- Automatic backup runs when the app opens, not in the background.
- Restore writes the `.crypt` database back to WhatsApp's `Databases` folder; it
  does not copy media back into WhatsApp's media folders.
- The Telegram session is sealed with the vault key and kept in SQLite.
