# PicPocket

<p align="center">
  <img src="docs/images/banner.svg" alt="PicPocket Hero Banner" width="100%" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Security-Zero--Knowledge-brightgreen.svg" alt="Security: Zero-Knowledge" />
  <img src="https://img.shields.io/badge/Encryption-AES--256--GCM-blue.svg" alt="Encryption: AES-256-GCM" />
  <img src="https://img.shields.io/badge/Protocol-MTProto%20v2.0-blueviolet.svg" alt="Protocol: MTProto" />
  <img src="https://img.shields.io/badge/PWA-Installable-orange.svg" alt="PWA: Ready" />
</p>

---

A private, client-side Google Photos–style gallery that turns your own Telegram channels into an encrypted personal cloud vault. **No backend servers, no analytics, no plaintext uploads**: the browser talks directly to Telegram via MTProto WebSockets, and every file is sealed locally with non-extractable keys inside a dedicated Web Worker before transmission.

---

## 📱 Mobile & Web App Preview

<p align="center">
  <img src="docs/images/picpocket-mobile-ui.png" alt="PicPocket Mobile Web App Interface" width="320" style="border-radius: 14px; box-shadow: 0 12px 30px rgba(0,0,0,0.6);" />
  <br />
  <em>PicPocket running as a standalone Progressive Web App (PWA) with full-width search, floating action controls, and multi-vault management.</em>
</p>

---

## ✨ Features at a Glance

<p align="center">
  <img src="docs/images/features-grid.svg" alt="PicPocket Feature Highlights" width="100%" />
</p>

- **Google Photos–Style UI** — Virtualized masonry timeline grouped by date, full-width search, channel switcher, swipeable lightbox with multi-touch zoom (up to 4×), video playback, and dark/light themes.
- **Zero-Knowledge Vault Encryption** — PBKDF2-SHA256 (600,000 iterations) derives a non-extractable AES-256-GCM key inside an isolated Web Worker.
- **Fresh IVs & EXIF Scrubbing** — Every encryption generates a cryptographically random 12-byte IV (`crypto.getRandomValues`) with zero IV reuse. EXIF and GPS geolocation metadata are stripped client-side prior to sealing.
- **Smart 32 MB Container Packing** — Files smaller than 10 MB are bundled into `bundle_<uuid>.bin` archives of roughly 32 MB with an encrypted `TGB1B:` index, replacing dozens of chat messages with a single envelope.
- **4 KB-Aligned Range Streaming** — Originals and thumbnails in containers are streamed on demand via MTProto partial range downloads aligned to Telegram's 4 KB boundary. You never download the entire bundle just to view one photo.
- **Anti-Ban Safety & Pacing Engine** — Compliant with Telegram's strict anti-spam limits: album batching (up to 10 photos per call), serialized write lanes with 6.0–12.0 s randomized jitter, and automated `FLOOD_WAIT_n` backoff with safety buffers.
- **WhatsApp Local Backup Sync** — Select and backup local WhatsApp databases (`msgstore.db.crypt14/15`) and media folders directly to a dedicated Telegram channel with local deduplication.
- **Installable PWA & Web Share Target** — Works offline for application assets, installs to homescreens, and accepts incoming photos and backups directly from native iOS & Android system share sheets.

---

## 🏗️ Architecture & Dataflow

<p align="center">
  <img src="docs/images/architecture.svg" alt="PicPocket System Architecture" width="100%" />
</p>

1. **Client Isolation:** The frontend executes exclusively in the user's browser. `public/_headers` enforces a strict Content Security Policy (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `Permissions-Policy`), preventing unauthorized network leakage.
2. **Web Worker Core:** Key derivation and encryption take place in `src/workers/crypto.worker.ts`. The derived `CryptoKey` is marked `extractable: false` so it can never be extracted by other scripts.
3. **Sealed Telegram Channel:** Documents are posted to your private channel as opaque `.bin` attachments with encrypted caption routing:
   - `TGP1H:<base64url>` — Public channel header salt & verifier for multi-device sync without exposing the passphrase.
   - `TGP1M:<base64url>` — Sealed individual media metadata and initialization vector.
   - `TGB1B:<base64url>` — Sealed index for 32 MB packed containers.
   - `WAB1M:` / `WAB1C:` — Manifest and chunk slices for WhatsApp backups.

---

## 🔐 Cryptographic Lifecycle

<p align="center">
  <img src="docs/images/crypto-flow.svg" alt="Zero-Knowledge Cryptographic Lifecycle" width="100%" />
</p>

| Stage | Primitive | Purpose |
| --- | --- | --- |
| **Passphrase Stretcher** | PBKDF2-SHA256 (600,000 iterations) | Derives 256-bit vault key from user passphrase and CSPRNG salt |
| **Vault Encryption Key** | AES-256-GCM (`extractable: false`) | Kept in Worker memory; encrypts session and media blobs |
| **Nonce / IV** | 12-byte CSPRNG (`crypto.getRandomValues`) | Fresh, unique IV per media chunk and metadata envelope |
| **Integrity Verification** | GCM 128-bit Authentication Tag | Detects tampering or bit-rot before decryption |
| **Session Persistence** | AES-GCM Sealed Session in IndexedDB | Telegram MTProto session is encrypted before writing to Dexie |

---

## 🛠️ Tech Stack

- **UI Framework:** React 18, TypeScript, Tailwind CSS v4, Lucide Icons
- **MTProto Protocol:** `@mtcute/web` (Direct Telegram MTProto over WebSockets with WebAssembly crypto)
- **Local Storage:** Dexie (IndexedDB) for encrypted sessions and cached thumbnails
- **Cryptography:** Web Crypto API + Dedicated Web Worker (`crypto.worker.ts`)
- **PWA / Service Worker:** `vite-plugin-pwa` + Workbox with Web Share Target POST handler
- **Build System:** Vite 6

---

## 🚀 Getting Started

### Prerequisites

- Node.js 20+
- A Telegram account and an API application ID (get one at [my.telegram.org/apps](https://my.telegram.org/apps)).

### Setup & Run Locally

```bash
# 1. Clone the repository
git clone https://github.com/frequency/PicPocket.git
cd PicPocket

# 2. Install dependencies (zero-install audit verified)
npm install

# 3. Configure Telegram API credentials
cp .env.example .env
# Edit .env with your VITE_TELEGRAM_API_ID and VITE_TELEGRAM_API_HASH

# 4. Start the development server
npm run dev
```

Open `http://localhost:5173` in your browser.

> **Note on Credentials:** `VITE_TELEGRAM_API_*` is optional. If left blank, PicPocket prompts you to enter your credentials on the login screen and stores them locally in your browser.

### Available Scripts

| Command | Action |
| --- | --- |
| `npm run dev` | Starts local Vite development server with HMR |
| `npm run build` | Compiles production assets and generates PWA service worker into `dist/` |
| `npm run preview` | Previews the production build locally |
| `npm run typecheck` | Runs strict TypeScript verification (`tsc --noEmit`) |
| `npm run icons` | Regenerates PWA icons |

---

## 🌐 Deployment

Because PicPocket is 100% client-side, it deploys to any static hosting service.

### Cloudflare Pages / Workers

1. Connect your repository to Cloudflare Pages.
2. Configure build settings:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
3. Add environment variables under **Settings → Environment Variables**:
   - `VITE_TELEGRAM_API_ID`
   - `VITE_TELEGRAM_API_HASH`
4. The included `public/_headers` automatically configures security headers (CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Permissions-Policy`).

### Vercel

Import the repository in Vercel with:
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- Configured automatically via `vercel.json`.

---

## 🛡️ Anti-Ban & Rate-Limit Compliance

PicPocket is engineered according to Telegram's official API guidelines to protect user accounts from automated spam flags:

- **Album Grouping:** Up to 10 photos or videos are batched into a single media group call rather than firing individual requests.
- **Paced Writes:** Enforces 6.0–12.0 s randomized delays between consecutive upload batches.
- **FloodWait Handling:** Catches MTProto `FLOOD_WAIT_X` exceptions and sleeps for `X + 4.0s` jitter buffer before resuming.
- **Cached InputPeers:** Access hashes and peer identifiers are cached locally to eliminate repetitive entity resolution calls.

---

## 📂 Project Structure

```text
PicPocket/
├── docs/
│   └── images/              # Architecture, flowcharts, banner, and UI assets
├── public/
│   ├── _headers             # Cloudflare Pages security headers and CSP
│   ├── manifest.json        # Web App Manifest & Web Share Target configuration
│   └── theme-init.js        # Zero-flash theme bootstrapper
├── src/
│   ├── components/          # UI: AuthScreen, PhotoGrid, Lightbox, TopBar, WhatsAppBackupView
│   ├── hooks/               # useTelegramAuth, useFullMedia, useThumbnail, useChannelMedia
│   ├── lib/                 # config, format, timeline grouping
│   ├── services/
│   │   ├── cache/           # Dexie database schema and thumb storage
│   │   ├── crypto/          # Web Worker client and encoding utilities
│   │   ├── media/           # Upload pacing, container bundling, EXIF scrubbing
│   │   ├── telegram/        # MTProto façade, captions, anti-ban queue
│   │   └── whatsapp/        # WhatsApp folder backup, chunking, deduplication
│   ├── workers/             # Dedicated AES-256-GCM / PBKDF2 Web Worker
│   ├── App.tsx              # Root app orchestrator and view routing
│   ├── main.tsx             # React entrypoint
│   └── sw.ts                # Workbox service worker & share target interceptor
├── SECURITY.md              # Security policies and cryptographic specifications
└── vite.config.ts           # Vite + Tailwind + PWA bundler configuration
```

---

## 📄 License

PicPocket is released under the [MIT License](LICENSE).
