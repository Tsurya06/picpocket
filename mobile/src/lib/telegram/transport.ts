/**
 * WebSocket transport for mtcute on React Native.
 *
 * `@mtcute/web`'s transport does exactly this, but that package also pulls in
 * its WASM crypto provider, which Hermes cannot load. RN ships a WebSocket
 * implementation, so the transport can be built from the core codecs.
 */
import { connectWs } from '@fuman/net';
import { IntermediatePacketCodec, ObfuscatedPacketCodec } from '@mtcute/core';

const SUBDOMAINS: Record<number, string> = {
  1: 'pluto',
  2: 'venus',
  3: 'aurora',
  4: 'vesta',
  5: 'flora',
};

export class RnWebSocketTransport {
  constructor(
    private readonly implementation: typeof WebSocket = WebSocket,
    private readonly baseDomain = 'web.telegram.org',
  ) {}

  async connect(
    dc: { id: number; testMode?: boolean },
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    const subdomain = SUBDOMAINS[dc.id] ?? 'pluto';
    const url = `wss://${subdomain}.${this.baseDomain}/apiws${dc.testMode ? '_test' : ''}`;
    return connectWs(
      { url, implementation: this.implementation, protocols: 'binary' },
      abortSignal,
    );
  }

  packetCodec(): ObfuscatedPacketCodec {
    return new ObfuscatedPacketCodec(new IntermediatePacketCodec());
  }
}
