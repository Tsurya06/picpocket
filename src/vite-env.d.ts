/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Pre-filled Telegram API ID for self-hosters. */
  readonly VITE_TELEGRAM_API_ID?: string;
  /** Pre-filled Telegram API hash for self-hosters. */
  readonly VITE_TELEGRAM_API_HASH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
