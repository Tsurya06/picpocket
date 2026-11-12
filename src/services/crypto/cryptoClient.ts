import type { RequestMap, WorkerRequest, WorkerRequestType, WorkerResponse } from '../../types/worker';

type Pending = {
  resolve: (value: RequestMap[WorkerRequestType]['response']) => void;
  reject: (reason: Error) => void;
};

/**
 * Promise-based, fully typed handle to the crypto worker.
 * The AES key lives inside the worker; this class only ever sees ciphertext or
 * explicitly requested plaintext bytes.
 */
class CryptoWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private unlocked = false;

  constructor() {
    this.worker = new Worker(new URL('../../workers/crypto.worker.ts', import.meta.url), {
      type: 'module',
      name: 'vault-crypto',
    });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);
      if (response.ok) {
        entry.resolve(response.response);
      } else {
        entry.reject(new Error(response.error));
      }
    });
    this.worker.addEventListener('error', (event) => {
      const reason = new Error(event.message || 'The crypto worker crashed.');
      for (const entry of this.pending.values()) entry.reject(reason);
      this.pending.clear();
    });
  }

  private request<K extends WorkerRequestType>(
    type: K,
    payload: RequestMap[K]['payload'],
  ): Promise<RequestMap[K]['response']> {
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, type, payload } as WorkerRequest;
    return new Promise<RequestMap[K]['response']>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as RequestMap[K]['response']),
        reject,
      });
      this.worker.postMessage(message);
    });
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  async unlock(passphrase: string, options?: { salt?: string; verifier?: string }): Promise<{
    salt: string;
    verifier: string;
  }> {
    const result = await this.request('unlock', {
      passphrase,
      salt: options?.salt,
      verifier: options?.verifier,
    });
    this.unlocked = true;
    return result;
  }

  async lock(): Promise<void> {
    await this.request('lock', undefined);
    this.unlocked = false;
  }

  prepareMedia(input: {
    data: ArrayBuffer;
    mime: string;
    name: string;
    lastModified: number;
  }): Promise<RequestMap['prepareMedia']['response']> {
    return this.request('prepareMedia', input);
  }

  encryptMeta(meta: RequestMap['encryptMeta']['payload']['meta']): Promise<string> {
    return this.request('encryptMeta', { meta }).then((result) => result.caption);
  }

  decryptMeta(caption: string): Promise<RequestMap['decryptMeta']['response']['meta']> {
    return this.request('decryptMeta', { caption }).then((result) => result.meta);
  }

  encryptBytes(data: ArrayBuffer): Promise<ArrayBuffer> {
    return this.request('encryptBytes', { data }).then((result) => result.data);
  }

  /** Encrypts one bounded chunk; the caller streams the source file. */
  encryptChunk(data: ArrayBuffer): Promise<ArrayBuffer> {
    return this.request('encryptChunk', { data }).then((result) => result.data);
  }

  decryptBytes(data: ArrayBuffer): Promise<ArrayBuffer> {
    return this.request('decryptBytes', { data }).then((result) => result.data);
  }

  encryptThumb(data: ArrayBuffer): Promise<ArrayBuffer> {
    return this.request('encryptThumb', { data }).then((result) => result.data);
  }

  /** Encrypts every item separately, then concatenates them into one bundle. */
  packBundle(items: readonly ArrayBuffer[]): Promise<RequestMap['packBundle']['response']> {
    return this.request('packBundle', { items: [...items] });
  }

  /** Decrypts exactly one packed slice (`[IV][ciphertext+tag]`). */
  decryptPacked(data: ArrayBuffer): Promise<ArrayBuffer> {
    return this.request('decryptPacked', { data }).then((result) => result.data);
  }
}

export const cryptoClient = new CryptoWorkerClient();
