/**
 * @fugood/react-native-audio-pcm-stream ships its own index.d.ts, but that
 * file declares `declare module "react-native-live-audio-stream"` — the
 * package's old, pre-rename npm name — not
 * `declare module "@fugood/react-native-audio-pcm-stream"`, the name it's
 * actually installed and imported under. TypeScript won't apply an ambient
 * declaration for a different module specifier, so without this the import
 * has no usable types under `strict`. This mirrors the shape of the
 * upstream .d.ts, just declared under the real package name.
 */
declare module "@fugood/react-native-audio-pcm-stream" {
  export interface AudioPcmStreamOptions {
    sampleRate: number;
    /** 1 = mono, 2 = stereo */
    channels: number;
    /** 8 or 16 */
    bitsPerSample: number;
    /** Android `MediaRecorder.AudioSource` constant, e.g. VOICE_RECOGNITION = 6 */
    audioSource?: number;
    wavFile?: string;
    bufferSize?: number;
  }

  export interface AudioPcmStream {
    init: (options: AudioPcmStreamOptions) => void;
    start: () => void;
    stop: () => void;
    /** `data` fires with base64-encoded raw PCM chunks while recording. */
    on: (event: "data", callback: (base64Chunk: string) => void) => { remove: () => void };
  }

  const AudioRecord: AudioPcmStream;
  export default AudioRecord;
}
