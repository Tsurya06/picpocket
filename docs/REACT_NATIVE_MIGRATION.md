# React Native migration assessment

Status: **planning / decision gate**. The Android/Capacitor experiment has been
removed; the repository is reset to `bda1547` (HEIC previews, cross-device vault
unlock, forgot-passphrase reset).

## 1. Executive decision

A React Native rewrite is **technically possible**, but it is **not a way to
save storage**. It makes both the installed app and the development environment
larger.

| Thing | Current web/PWA | React Native plan |
| --- | --- | --- |
| App download | ~4.5 MB precache; 6.3 MB debug Capacitor APK | ~16 MB base before app code; TDLib adds native binaries |
| Installed app | browser-managed | ~34 MB base before TDLib; likely 50–80 MB with TDLib and assets |
| Dependencies | `node_modules` ~229 MB | RN + TDLib unpacked is ~152 MB for TDLib alone; full tree is larger |
| Build tooling | Vite/Node only | Android SDK + Gradle + NDK + Metro; typically 2–4 GB |
| Reverse engineering | JS bundle is readable; Hermes/obfuscation helps | Hermes + R8 + native code raises cost, but cannot prevent it |

Measured package sizes (npm, November 2026):

- `react-native@0.88.1`: ~21 MB unpacked
- `react-native-tdlib@2.3.0`: ~152 MB unpacked, prebuilt TDLib for Android/iOS
- `react-native-quick-crypto@1.1.9`: ~6 MB
- `react-native-keychain@11.0.0`: ~0.3 MB
- `react-native-quick-scure-bip39@1.0.0`: ~0.17 MB

**Recommendation:** if saving disk space is the primary goal, stay on the web
app and add only the native pieces that are strictly necessary. Migrate to React
Native only if true any-folder background sync, native key storage, and native
code hardening are worth a materially larger app and toolchain.

A native Kotlin app would be smaller and harder to reverse than React Native,
but it would throw away the React UI. React Native is the compromise that keeps
the UI while adding native capabilities.

## 2. What "any folder" means

The removed experiment wrongly assumed `DCIM/Camera`. The replacement must let
the user choose **any folder** the OS grants access to.

### Android

- Use the Storage Access Framework: `ACTION_OPEN_DOCUMENT_TREE`.
- Persist access with `takePersistableUriPermission`.
- Enumerate recursively with `DocumentFile` / `DocumentsContract`.
- Store the tree URI in the encrypted settings database.
- Read each document through `ContentResolver`, copy it to an app-private cache
  file (TDLib requires a local path), then encrypt/upload in a native worker.
- Skip hidden files, `.trash`, zero-byte files, and unsupported providers.
- Dedupe with `(documentId, size, lastModified)` in the encrypted local DB.
- Run daily with WorkManager + a `dataSync` foreground service, with Wi-Fi and
  charging constraints. Android scheduling is inexact; the chosen time is a
  target, not an alarm.

### iOS

- `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])`.
- Save a security-scoped bookmark, resolve it on later launches, and call
  `startAccessingSecurityScopedResource` while reading.
- Use `BGProcessingTask` for opportunistic overnight work. iOS decides when it
  runs; a fixed daily time is not guaranteed. Always also sync on app open.

## 3. Telegram layer

Use `react-native-tdlib` (TDLib 2.3.x at the time of writing) in a **bare**
React Native app, not Expo managed, because the app needs custom native modules.

TDLib covers:

- Authentication and persistent sessions.
- `getChatHistory`, `getChat`, `getMessage`.
- `downloadFile` with `offset` and `limit`, which is required for reading ranges
  out of packed encrypted bundles.
- Local file upload through `inputFileLocal` and `inputMessageDocument`.
- Albums through `sendMessageAlbum`.
- `deleteMessages`.
- Flood-wait errors; add the existing pacing layer on top.

Compatibility work:

- TDLib uses marked `chatId` values; the existing captions use raw channel ids.
  Add one adapter and never leak Telegram ids into the vault format.
- The existing mtcute session string **cannot** be imported into TDLib. Users
  sign in once on the new app. Encrypted media and channel headers remain
  readable because they are content, not session state.
- Keep the existing caption formats byte-for-byte:
  `TGP1` metadata, `TGB1B` bundle document, `TGB1C` bundle index, `TGP1H`
  channel header. This is what makes migration non-destructive.
- TDLib stores its own database. Encrypt it with a database key derived from the
  vault key, and keep the key in Keystore/Keychain.

## 4. Key hierarchy and the 24-word recovery phrase

The current web design derives the vault key directly from the passphrase:
`K = PBKDF2(passphrase, salt, 600k)`. That makes a forgotten passphrase
unrecoverable, and WebCrypto marks the key non-extractable.

The React Native design should move to a key hierarchy:

```text
recovery entropy R (32 random bytes)
        │
        ├── 24 BIP39 words  =  English mnemonic of R
        │
        └── master key K = R

passphrase ──PBKDF2(salt, 600k)──> wrapping key W
K ──AES-256-GCM(W)──> wrappedK  (stored locally and in the vault header)

channel key = HKDF(K, channelId) for new channels
legacy channel keys ──AES-256-GCM(K)──> keyring (stored with the vault metadata)
```

- 24 words = 256 bits of BIP39 entropy. Use the English wordlist and generate
  with a CSPRNG (`react-native-quick-scure-bip39` or an equivalent audited
  library).
- The mnemonic is the master secret. It is shown once, requires the user to
  re-enter three random words, and is never written to storage or logs.
- The passphrase is a convenience unlock, not the root of recovery. It wraps K.
- A new device can recover with **either** the passphrase or the 24 words.
- The user can change the passphrase without re-encrypting media: only
  `wrappedK` changes.
- The mnemonic must never be sent to Telegram, a server, analytics, or a crash
  reporter. Disable screenshots on the reveal screen (`FLAG_SECURE`), clear the
  clipboard after a timeout, and never put it in an auto-backup.

### Migrating existing vaults

Existing media is encrypted with keys derived from the old passphrase. Do not
re-encrypt it.

1. In the RN app (native crypto, extractable key), derive the old primary key
   `K_old` from the passphrase and the stored salt.
2. Export `K_old`; generate a 24-word mnemonic for it.
3. Wrap `K_old` under the new passphrase-derived wrapping key.
4. For every channel, derive/export the old channel key, then store it in a
   keyring sealed with `K_old`.
5. New uploads continue to use `K_old` / the channel keys, so all old and new
   content decrypts with one recovered root.
6. Publish an updated header that contains `wrappedK` and the sealed keyring.
   Older clients ignore the extra fields; new clients use them.

This is the only migration path that preserves existing ciphertext without
re-uploading it. It requires the user's old passphrase once, during migration.

### What the 24 words do **not** recover

- They do not restore a revoked Telegram session. The user must sign in again.
- They do not recover a lost mnemonic. There is no server and no backdoor.
- They do not protect against a compromised device that can observe the app
  while it is unlocked.

## 5. HEIC

HEIC must be converted on-device before encryption:

- iOS: ImageIO/CoreImage, honor orientation, convert to JPEG or WebP.
- Android: `ImageDecoder`/`BitmapFactory` + ExifInterface; HEIC support depends
  on the OS codec (Android 10+ generally).
- Handle 10-bit HDR HEIC explicitly; some Android conversions fail. If
  conversion fails, upload the original bytes sealed, with `kind: file` or the
  original MIME, rather than silently dropping the photo.
- Strip EXIF/GPS **after** conversion, then encrypt.
- Keep a test corpus: 8-bit HEIC, 10-bit HDR, portrait orientation, burst
  photos, screenshots, and HEIC with GPS.

## 6. UI and data port

- UI: reuse the React component structure, but replace DOM/Tailwind with React
  Native primitives and NativeWind or StyleSheet.
- State: keep the same hooks where possible; replace Dexie with encrypted
  SQLite (`op-sqlite` + SQLCipher, or a similar audited binding).
- Previews: store encrypted thumbnails in app-private files, not a plain
  cache. Decrypt on demand with a small in-memory LRU.
- Video: use `react-native-video` for playback; keep encrypted downloads in a
  temporary directory and delete on close.
- Share sheet: Android `Intent` filters, iOS Share Extension.
- Background: a native headless task/module calls the same sync service; do not
  rely on JS timers.

## 7. Hardening against reverse engineering

There is no way to make a client app impossible to reverse engineer. The goal
is to raise cost and protect the right secrets.

Layers that are worth doing:

- Release builds only: Hermes bytecode, Metro minification, R8 full mode,
  resource shrinking, and symbol stripping.
- JavaScript obfuscation before Hermes (string encryption, control-flow
  flattening). Treat it as friction, not encryption.
- Put key derivation, AES-GCM, and the 24-word handling in a small native C++
  module behind a narrow JSI API, not in JS. This keeps keys out of the JS heap
  and makes hooking the JS bridge less useful.
- No secrets in the bundle. Telegram `api_id`/`api_hash` are app identifiers,
  not user secrets; never embed a user key.
- Android Keystore / iOS Keychain for `wrappedK`, with optional biometric
  access. Do not store the mnemonic.
- `FLAG_SECURE` on recovery, passphrase, and media screens.
- Certificate pinning to Telegram is fragile and can break; prefer standard TLS
  and do not claim pinning if it is not maintained.
- Root/emulator/Frida/debugger detection as a **signal**, not a security
  boundary. It can be hooked and bypassed.
- Play Integrity / App Attest require a server to verify the verdict. This app
  has no backend; a client-only check is not trustworthy. If attestation is
  required, add a minimal verification service, which changes the zero-backend
  model.
- Signed AAB, reproducible builds, dependency pinning, no debug logging, and a
  published threat model.

Threat model to state plainly: a determined attacker with the device, a debugger,
and unlimited time can observe decrypted media and keys while the app is
unlocked. Encryption protects data at rest and in transit, not a compromised
endpoint.

## 8. Storage budget

Current repository after reset: ~237 MB, of which `node_modules` is ~229 MB.

A React Native setup is expected to add:

- Android SDK, build-tools, platform, NDK, Gradle caches: 2–4 GB.
- RN + TDLib + native modules: several hundred MB in `node_modules`.
- Build outputs: hundreds of MB per ABI unless cleaned.

If disk space is the constraint, the correct move is **not** React Native. Use
the web app, clean build caches, and add only a small native module if a
specific capability is unavoidable.

## 9. Phased migration plan

### Phase 0 — feasibility spike (1–2 days)

- Create a throwaway RN 0.88 bare app.
- Add `react-native-tdlib`, `react-native-quick-crypto`, SAF, and a minimal
  encrypted upload/download.
- Prove: login, list a channel, upload one encrypted document, download a byte
  range, read a folder tree, persist folder permission.
- Measure APK/AAB size and build-tool disk usage.
- Exit: a device-tested spike and a real size number. Stop here if size is a
  blocker.

### Phase 1 — foundation (1 week)

- Bare RN project, Hermes, New Architecture, TypeScript, navigation.
- Native modules: TDLib adapter, crypto/keyring, secure storage, SAF.
- Encrypted SQLite schema and migration.
- Key hierarchy + 24-word generation/reveal/verify/recover.
- Auth and session persistence.

### Phase 2 — vault compatibility (1–2 weeks)

- Port caption parsers and bundle format unchanged.
- Upload: encrypted originals, thumbnails, bundles, albums.
- Download: range reads, thumbnails, full originals, video.
- Timeline, search, albums, delete, share.
- Cross-device header/keyring migration.

### Phase 3 — any-folder sync (1 week)

- Folder picker and persisted permission.
- Recursive scan, dedupe manifest, copy/encrypt/upload pipeline.
- Daily WorkManager foreground job, constraints, notification, retry.
- Settings UI: folder, time, Wi-Fi/charging, pause, last run.
- Android device tests with app killed, reboot, permission revoked, and folder
  moved/deleted.

### Phase 4 — UI port (1 week)

- Gallery, lightbox, video, upload, settings, onboarding, recovery screens.
- Accessibility, dark theme, offline states.
- Share target on both platforms.

### Phase 5 — hardening and release (1 week)

- R8, Hermes, JS obfuscation, native crypto module, FLAG_SECURE.
- Release AAB, ABI splits, size report.
- Migration test from an existing web vault.
- Threat model, privacy policy, incident checklist.

Total: roughly 5–7 weeks of focused work for one experienced developer, plus
device testing. This is not a drop-in replacement.

## 10. Decision gate

Before writing migration code, choose one:

1. **Stay web / PWA.** Smallest install and development footprint. Add 24-word
   recovery and native folder sync only if a specific platform gap must be
   closed. Accept that browser background execution is limited.
2. **React Native.** Best compromise for native any-folder background sync and
   native key storage while keeping React. Larger app, larger toolchain, and
   still not reverse-engineering-proof.
3. **Native Kotlin (Android-first).** Smallest and hardest to reverse of the
   three, but the UI and much of the code must be rewritten; no iOS parity
   without a separate Swift app.

The 24-word recovery work is independent of this choice and should be designed
once, in a platform-neutral keyring specification, before either client
implements it.
