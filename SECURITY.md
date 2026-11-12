# Security Policy

## Supported versions

Security fixes are applied to the latest `1.x` release on the default branch.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) instead of opening a public issue. Include reproduction steps, the affected browser, and the impact. Do not include real passphrases, session strings, or Telegram API credentials.

## Threat model

### Assets

- Vault passphrase and the derived AES-256-GCM key.
- Telegram MTProto session (auth key / string session).
- Plaintext photos, videos, documents, captions, and EXIF metadata.
- Telegram API credentials (`api_id` / `api_hash`) and account identity.

### Protected against

- **Storage compromise at rest** — media is uploaded as AES-GCM ciphertext; the exported MTProto session is sealed with the vault key before being written to IndexedDB. Preview bytes decrypted for display live only in the local cache.
- **Hosting-layer disclosure** — there is no backend, no proxy, no analytics, and no server-side session. A static host serves the app shell only.
- **Network observers** — Telegram traffic uses WSS. Media payloads are already ciphertext before upload.
- **Accidental plaintext uploads** — vault mode sends `.bin` documents, never the original file. Metadata captions are encrypted with the same vault key. Direct mode is an explicit user opt-out.
- **Unauthorized posting** — MTProto uses the signed-in user's own account and only channels where the account can post.

### Not protected against

- **Compromised browser or origin** — XSS, a malicious extension, or a tampered build can act with the page's privileges while the vault is unlocked. The non-extractable worker key prevents exfiltration of the raw key, not decryption of displayed media.
- **Malicious or compromised Telegram infrastructure** — Telegram stores ciphertext documents but sees message sizes, timestamps, channel IDs, and the account's social graph.
- **Weak or reused passphrases** — PBKDF2 slows guessing but cannot rescue a low-entropy passphrase.
- **Loss of the passphrase** — there is no recovery service. Losing it makes existing vault media unreadable.
- **Local device access while unlocked** — cached decrypted previews and any open object URLs are available to someone with control of the browser profile.
- **Traffic analysis** — the number and timing of uploads/downloads are visible to Telegram and the network.

## Cryptographic design

All primitives use the browser's Web Crypto API inside `src/workers/crypto.worker.ts`.

| Purpose | Primitive / parameters |
| --- | --- |
| Key derivation | PBKDF2-HMAC-SHA-256, **600,000 iterations**, 16-byte random salt |
| Vault key | AES-256-GCM, derived as **non-extractable**; never leaves the worker |
| Envelope encryption | AES-256-GCM with a fresh random **12-byte IV** per envelope; 16-byte authentication tag |
| Vault verifier | AES-GCM encryption of a fixed known plaintext (`TGP1V:` prefix); unlocking verifies the key without storing it |
| Vault metadata | JSON descriptor encrypted as a `TGP1M:` caption, including name, MIME, dimensions, capture time, size, and optional caption |
| Preview images | Individually sealed, `TGP1T`-style document; decrypted only when a tile is viewed |
| Bundle packing | Each item (and optional preview) encrypted separately with its own IV and concatenated end-to-end; random access is by exact `byteOffset` / `byteLength` |
| Sealed session | `{ session, apiId, apiHash }` JSON encrypted with the vault key before persistence |

The AES key is created with `extractable: false`. The UI can request encryption/decryption operations, but cannot export raw key material.

### Per-channel keys

A channel publishes a public header message (`TGP1H:<base64url json>`) holding the salt and verifier of the vault that owns it. Other devices that sign into the same account read the header, re-derive the same key from the same passphrase, and cache it in the worker under that channel id. This also lets a device open a shared channel encrypted with a different passphrase without ever replacing the primary vault profile.

While unlocked, the worker holds the vault passphrase in memory so it can derive those per-channel keys without prompting again; the passphrase is cleared on lock and never persisted. Header messages reveal the salt (public by design) and the verifier (an AES-GCM encryption of a fixed known plaintext), never key material.

### Metadata leakage

- Telegram sees encrypted document sizes, MIME (`application/octet-stream`), upload timestamps, message order, and channel membership.
- File names, dimensions, capture dates, and captions are inside the encrypted metadata caption.
- Per-item ciphertext lengths reveal approximate plaintext sizes.
- IndexedDB stores the vault salt/verifier, the sealed session, and decrypted preview blobs used by the gallery cache.
- If custom API credentials are entered on the login screen, `api_id`/`api_hash` are stored in `localStorage` for convenience. They are application identifiers, not account secrets, but anyone with local profile access can read them.

## Anti-ban and rate limiting

`src/services/telegram/antiBan.ts` runs a single global queue in front of every RPC:

- **Writes** are serialized with a 700–1200 ms random gap between starts.
- **Reads** allow up to three concurrent calls, spaced by 90–200 ms jitter.
- **Flood waits** (`FLOOD_WAIT_n`, `SLOWMODE_WAIT_n`, `FLOOD_TEST_PHONE_WAIT_n`, `FLOOD_PREMIUM_WAIT_n`) pause the whole queue for the server-directed time plus one second, then retry up to three times.
- **Transient errors** (`TIMEOUT`, `NETWORK`, `CONNECTION`, `INTERNAL`, `-503`, etc.) retry with exponential backoff and jitter.
- **Abort signals** remove queued work and cancel in-flight delays, so cancelling an upload does not keep hitting Telegram.

This reduces the chance of account restrictions during large imports, but it is not a guarantee. Respect Telegram's Terms of Service and API limits.

## Deployment hardening

- Serve over HTTPS only.
- `vercel.json` and `public/_headers` set `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a restrictive Content Security Policy.
- The CSP allows only same-origin scripts, `wasm-unsafe-eval` for the MTProto WASM provider, blob/data media, and WSS connections to `*.web.telegram.org`.
- Production builds disable source maps and contain no analytics or third-party scripts.
- Never commit `.env`; only `.env.example` belongs in the repository.
