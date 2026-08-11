import { env } from "../../config/env";

const EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1/embeddings";
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Converts text into a 1536-dimensional embedding vector via OpenAI's
 * text-embedding-3-small model.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(EMBEDDINGS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Embeddings request failed (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}
