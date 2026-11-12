# PicPocket

A private, client-side Google Photos–style gallery that uses your own Telegram channels as encrypted storage. No backend, no analytics, no plaintext uploads: the browser talks MTProto directly to Telegram, and every vault file is sealed locally before it leaves the tab.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- **Google Photos–style UI** — date-grouped timeline, search, channel switcher, lightbox, upload progress, dark/light themes, installable PWA.
- **Zero-knowledge vault encryption** — PBKDF2-SHA256 (600,000 iterations) derives a non-extractable AES-256-GCM key inside a Web Worker. Sessions and media are sealed on the device; the hosting layer never sees plaintext.
- **10 MB threshold / 32 MB container packing** — small encrypted items are packed into `bundle_<uuid>.bin` containers of roughly 32 MB, with a sealed `TGB1B:` index recording each item's `bundleMessageId`, `byteOffset`, and `byteLength`. One 32 MB bundle replaces dozens of separate messages.
- **4 KB-aligned partial range downloads** — packed originals and previews are fetched with MTProto `offset`/`limit`, aligned down to Telegram's required 4 KB boundary, trimmed locally, then decrypted. Opening one tile never downloads the whole bundle.
- **WhatsApp local backup sync** — import WhatsApp backup files from a folder picker and mirror them into a selected Telegram channel, with a local dedupe manifest.
- **Anti-ban jitter queue** — one serialized write lane with 0.7–1.2 s jitter, up to three spaced reads, automatic `FLOOD_WAIT_n` handling with a safety margin, exponential backoff for transient network errors, and abort-aware cancellation.
- **PWA + share target** — installable shell, offline app assets, and Android/Web Share Target intake for files shared to the app.

## How it works

1. The browser opens an MTProto WebSocket to Telegram using your own `api_id` / `api_hash`.
2. A vault passphrase is stretched with PBKDF2-SHA256 and kept as a non-extractable AES-GCM key inside `src/workers/crypto.worker.ts`.
3. Photos and videos are stripped of EXIF/GPS locally, encrypted with a random 12-byte IV, and uploaded as `.bin` documents. Metadata and previews are sealed separately.
4. The gallery reads channel history, decrypts captions and previews, and fetches exact byte ranges from packed bundles on demand.
5. The exported MTProto session is encrypted with the vault key before it is written to IndexedDB, so a stolen device cannot resume the Telegram session without the passphrase.

## Tech stack

- React 18 + TypeScript + Vite
- Tailwind CSS v4
- `@mtcute/web` for MTProto over WebSockets
- Dexie (IndexedDB) for local caches and the sealed session
- Web Crypto + a dedicated crypto Web Worker
- `vite-plugin-pwa` / Workbox

## Local development

**Requirements:** Node.js 20+ and a Telegram API application.

1. Create an API app at [my.telegram.org/apps](https://my.telegram.org/apps). Copy its `api_id` and `api_hash`.
2. Clone the repository, then from its folder:

   ```bash
   npm install
   cp .env.example .env
   # edit .env with VITE_TELEGRAM_API_ID and VITE_TELEGRAM_API_HASH
   npm run dev
   ```

3. Open the printed local URL, sign in with a Telegram account that can post in the target channel, then create the vault passphrase.

`VITE_TELEGRAM_API_*` is optional. If it is omitted, the login screen exposes **Advanced: Custom API ID** and stores the values only in that browser's `localStorage`.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Typecheck and produce the static build in `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | Run `tsc --noEmit` |
| `npm run icons` | Regenerate PWA icons |

## Deploy

The app is fully static after build. `npm run build` emits `dist/` with the service worker and web manifest.

### Vercel

Import the repository in Vercel and use these settings:

- **Framework preset:** Vite
- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Environment variables:** `VITE_TELEGRAM_API_ID`, `VITE_TELEGRAM_API_HASH` (optional but recommended)

`vercel.json` adds SPA rewrites plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a Content Security Policy that allows WebAssembly, blob/data media, and `wss://*.web.telegram.org`.

### Cloudflare Workers (static assets)

`wrangler.jsonc` deploys `dist/` as static assets and sets
`not_found_handling: "single-page-application"`, so client-side routes fall back
to `index.html` without a `_redirects` file (which Cloudflare rejects as an
infinite loop).

- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy`
- **Root directory:** repository root
- **Variables and secrets:** add `VITE_TELEGRAM_API_ID` and `VITE_TELEGRAM_API_HASH` under **Settings → Build → Variables and secrets**. Vite inlines `VITE_*` values at build time, so rebuild after changing them.

`public/_headers` still applies the security headers to the deployed assets. For
Cloudflare Pages, use the same build command and output directory, and delete any
`_redirects` file so the platform's SPA routing handles deep links.

> HTTPS is required: Web Crypto, service workers, and MTProto WebSockets are unavailable on plain HTTP origins other than localhost.

## Telegram notes

- This is an independent client. It is not affiliated with Telegram or Google.
- `api_hash` is an application identifier, not an account password, but it is embedded in the client bundle when supplied through `VITE_*`. Treat a real `.env` as private and never commit it.
- There is no bot token and no server-side session. The app only accesses channels where your account has posting rights.
- Telegram rate limits apply. The built-in queue handles flood waits, but very large first-time syncs can still take time.
- Telegram's sandbox Test DC is intentionally not supported: production Telegram only.

## Security

See [SECURITY.md](SECURITY.md) for the threat model, cryptographic primitives, metadata leakage notes, and the rate-limiting design. Report vulnerabilities through a private GitHub security advisory, not a public issue.

## Project structure

```text
src/
  components/        UI: auth, timeline, lightbox, channel and settings modals
  hooks/             Auth, timeline, uploader, channel selection
  lib/               Config, formatting, timeline grouping
  services/
    cache/           Dexie schema and LRU preview cache
    crypto/          Worker client and encoding helpers
    media/           File preparation, uploads, bundle packing, thumbnails
    telegram/        MTProto façade, captions, anti-ban queue
    whatsapp/        Backup sync and share-target intake
  workers/           AES-GCM / PBKDF2 / EXIF-stripping crypto worker
  sw.ts              Workbox service worker + share target
public/              Icons, manifest, redirects and headers
```

## Contributing

Issues and pull requests are welcome. Keep the security model intact: no plaintext media uploads, no server-side session handling, no analytics, and no new network origins without updating the CSP in `vercel.json` and `public/_headers`.

## License

MIT © 2026 PicPocket contributors. See [LICENSE](LICENSE).
