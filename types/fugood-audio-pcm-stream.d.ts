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
    /** `data` fires with base64-encoded raw PCM chunks while recording.
     * `error` (Build 42 P1-5 fix, see patches/@fugood+react-native-audio-pcm-stream+1.1.4.patch)
     * fires once if the native recording thread's read loop throws — a mid-
     * recording mic-permission revocation or other native `AudioRecord`
     * failure — so callers can surface it instead of silently finalizing a
     * broken/empty recording. */
    on: {
      (event: "data", callback: (base64Chunk: string) => void): { remove: () => void };
      (event: "error", callback: (message: string) => void): { remove: () => void };
    };
  }

  /** Native session lifecycle state (MicSessionManager.java). "none":
   * no current session; "unknown": no record of that id in this process. */
  export type MicSessionStatus =
    | "initialized"
    | "capturing"
    | "stopping"
    | "releasing"
    | "released"
    | "releaseFailed"
    | "none"
    | "unknown";

  export interface MicSessionStatusResult {
    sessionId: number;
    status: MicSessionStatus;
    /** Known once the session has reached a terminal state. */
    lastSeq?: number;
    reason?: string;
  }

  export interface MicSessionDataEvent {
    sessionId: number;
    /** 1, 2, 3… within the session. */
    seq: number;
    /** Base64 raw PCM. */
    data: string;
  }

  export interface MicSessionReleasedEvent extends MicSessionStatusResult {
    /** False: release threw — the session keeps ownership ("releaseFailed"). */
    ok: boolean;
    lastSeq: number;
    reason: string;
  }

  export interface MicSessionErrorEvent {
    sessionId: number;
    message: string;
  }

  export interface MicSessionSilencedEvent {
    sessionId: number;
    /** False below Android 10, where silencing can't be observed. */
    supported: boolean;
    silenced: boolean;
  }

  /** Xayra Gate A: microphone sessions with a release acknowledgement. */
  export interface AudioPcmSessionApi {
    /** Resolves the new session id; rejects "busy" while any earlier
     * session (or the legacy recorder) is unreleased. */
    initSession: (options: AudioPcmStreamOptions) => Promise<number>;
    startSession: (id: number) => Promise<void>;
    /** A stop REQUEST: resolves with the state it left, never proof of
     * release — that is `sessionReleased`, or `sessionStatus` "released". */
    stopSession: (id: number) => Promise<MicSessionStatusResult>;
    /** Wakes a capture thread stuck in a read; never releases by itself. */
    forceRelease: (id: number) => Promise<MicSessionStatusResult>;
    /** id <= 0: the current session, if any. */
    sessionStatus: (id: number) => Promise<MicSessionStatusResult>;
    onSession: {
      (event: "sessionData", callback: (event: MicSessionDataEvent) => void): { remove: () => void };
      (event: "sessionReleased", callback: (event: MicSessionReleasedEvent) => void): { remove: () => void };
      (event: "sessionError", callback: (event: MicSessionErrorEvent) => void): { remove: () => void };
      (event: "sessionSilenced", callback: (event: MicSessionSilencedEvent) => void): { remove: () => void };
    };
  }

  const AudioRecord: AudioPcmStream & AudioPcmSessionApi;
  export default AudioRecord;
}
