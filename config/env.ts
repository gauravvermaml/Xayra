const OPENAI_API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? "";

if (!OPENAI_API_KEY) {
  console.warn(
    "[env] EXPO_PUBLIC_OPENAI_API_KEY is not set. Transcription and embedding calls will fail."
  );
}

export const env = {
  OPENAI_API_KEY,
};
