import * as FileSystem from "expo-file-system/legacy";

import { env } from "../../config/env";

const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Uploads a local audio file to OpenAI Whisper and returns the transcript text.
 */
export async function transcribeAudio(audioUri: string): Promise<string> {
  if (typeof FileSystem.uploadAsync !== "function") {
    throw new Error(
      "expo-file-system/legacy: uploadAsync is not available on this build."
    );
  }

  const result = await FileSystem.uploadAsync(WHISPER_ENDPOINT, audioUri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: "file",
    mimeType: "audio/m4a",
    parameters: { model: "whisper-1" },
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Whisper transcription failed (${result.status}): ${result.body}`);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(result.body);
  } catch {
    throw new Error(`Whisper returned a non-JSON response: ${result.body}`);
  }

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    typeof (parsedBody as { text?: unknown }).text !== "string"
  ) {
    throw new Error(`Whisper response did not include transcript text: ${result.body}`);
  }

  return (parsedBody as { text: string }).text;
}
