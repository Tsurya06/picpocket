declare module 'heic-decode' {
  export interface DecodedHeic {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  }

  export interface DecodeOptions {
    readonly buffer: Uint8Array | ArrayBuffer;
  }

  function decode(options: DecodeOptions): Promise<DecodedHeic>;
  export default decode;
}
