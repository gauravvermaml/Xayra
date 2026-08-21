import * as FileSystem from "expo-file-system/legacy";
import { InferenceSession, Tensor } from "onnxruntime-react-native";

import { ensureEmbeddingAssets } from "./embeddingModel";
import { logDuration, nowMs } from "./perf";
import { encode, loadVocab, type Vocab } from "./tokenizer";

/** bge-small-en-v1.5's hidden size — also the dimension `note_embeddings` is
 * created with (see db/schema.ts's NOTE_EMBEDDINGS_TABLE_SQL). */
export const EMBEDDING_DIMENSIONS = 384;

/** Neither is bundled into the app (the model alone is tens of MB) — both
 * are expected to already be sitting in the document directory, same
 * pattern as services/ai/localWhisper.ts's GGML model resolution. */
const MODEL_FILENAME = "bge-small-en-v1.5-quantized.onnx";
const VOCAB_FILENAME = "bge-small-en-v1.5-vocab.txt";

/** bge-small-en-v1.5 supports up to 512 tokens; capped lower here to bound
 * per-note inference latency on-device — plenty for voice-note-length text. */
const MAX_SEQUENCE_LENGTH = 256;

const EXPECTED_INPUT_NAMES = ["input_ids", "attention_mask", "token_type_ids"];

let sessionPromise: Promise<InferenceSession> | null = null;
let vocabPromise: Promise<Vocab> | null = null;

function resolveAssetPath(filename: string): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }
  return `${dir}${filename}`;
}

/**
 * Auto-remediating: rather than immediately throwing when the model/vocab
 * files are missing (e.g. the user skipped onboarding, or the app was
 * reinstalled), this transparently downloads them first via
 * embeddingModel.ts's `ensureEmbeddingAssets()` — a background fetch, not a
 * blocking modal, so a note being saved just takes a bit longer the first
 * time instead of failing outright. Still throws a clear error if that
 * download itself fails (e.g. genuinely offline), rather than pretending
 * the file exists.
 */
async function requireAssetExists(filename: string): Promise<string> {
  await ensureEmbeddingAssets();
  const path = resolveAssetPath(filename);
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    throw new Error(
      `${filename} could not be downloaded automatically. Check your connection and try again, ` +
        `or place it manually in the app's document directory (${FileSystem.documentDirectory}).`
    );
  }
  return path;
}

/**
 * Loading the ONNX model is expensive, so the session is created once and
 * reused. If creation fails, the next call retries instead of replaying a
 * cached rejection forever.
 */
async function getSession(): Promise<InferenceSession> {
  if (!sessionPromise) {
    const coldStart = nowMs();
    sessionPromise = requireAssetExists(MODEL_FILENAME)
      .then((path) => InferenceSession.create(path))
      .then((session) => {
        const missing = EXPECTED_INPUT_NAMES.filter((name) => !session.inputNames.includes(name));
        if (missing.length > 0) {
          throw new Error(
            `${MODEL_FILENAME} doesn't expose the expected BERT-style input(s) ${missing.join(", ")} ` +
              `(found: ${session.inputNames.join(", ")}). This ONNX export may use different input names.`
          );
        }
        logDuration("ONNX cold-start (model load from disk)", coldStart);
        return session;
      });
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

async function getVocab(): Promise<Vocab> {
  if (!vocabPromise) {
    vocabPromise = requireAssetExists(VOCAB_FILENAME).then(loadVocab);
    vocabPromise.catch(() => {
      vocabPromise = null;
    });
  }
  return vocabPromise;
}

/** Mean-pools token hidden states into one sentence vector, ignoring padding
 * positions via the attention mask (the standard bge/sentence-transformers
 * pooling strategy — using [CLS] alone underperforms for these models). */
function meanPool(hidden: Float32Array, attentionMask: number[], hiddenSize: number): number[] {
  const pooled = new Array(hiddenSize).fill(0);
  let unmaskedCount = 0;

  attentionMask.forEach((mask, tokenIndex) => {
    if (mask === 0) {
      return;
    }
    unmaskedCount += 1;
    const offset = tokenIndex * hiddenSize;
    for (let dim = 0; dim < hiddenSize; dim++) {
      pooled[dim] += hidden[offset + dim];
    }
  });

  const denom = unmaskedCount || 1;
  return pooled.map((sum) => sum / denom);
}

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/**
 * bge ONNX exports vary in what they name their hidden-state output
 * depending on the conversion tool — try the common names, then fall back
 * to whatever the model's first declared output is.
 */
function pickHiddenStateOutput(
  session: InferenceSession,
  outputs: InferenceSession.ReturnType
): Tensor {
  const preferredNames = ["last_hidden_state", "hidden_state", "output"];
  for (const name of preferredNames) {
    const value = outputs[name];
    if (value) {
      return value;
    }
  }
  const fallback = outputs[session.outputNames[0]];
  if (!fallback) {
    throw new Error("ONNX session produced no usable output tensor.");
  }
  return fallback;
}

/**
 * Generates a 384-dim sentence embedding for `text` entirely on-device via
 * a quantized bge-small-en-v1.5 ONNX model — no network round-trip, no
 * OpenAI API key. Mean-pools the token hidden states (masking padding) and
 * L2-normalizes, so cosine similarity in sqlite-vec behaves correctly.
 */
export async function generateEmbeddingLocal(text: string): Promise<number[]> {
  const start = nowMs();
  const [session, vocab] = await Promise.all([getSession(), getVocab()]);
  const { inputIds, attentionMask, tokenTypeIds } = encode(text, vocab, MAX_SEQUENCE_LENGTH);

  const feeds = {
    input_ids: new Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]),
    attention_mask: new Tensor(
      "int64",
      BigInt64Array.from(attentionMask.map(BigInt)),
      [1, attentionMask.length]
    ),
    token_type_ids: new Tensor(
      "int64",
      BigInt64Array.from(tokenTypeIds.map(BigInt)),
      [1, tokenTypeIds.length]
    ),
  };

  const outputs = await session.run(feeds);
  const hiddenOutput = pickHiddenStateOutput(session, outputs);
  const hiddenSize = (hiddenOutput.dims[hiddenOutput.dims.length - 1] as number) ?? EMBEDDING_DIMENSIONS;

  const pooled = meanPool(hiddenOutput.data as Float32Array, attentionMask, hiddenSize);
  const normalized = l2Normalize(pooled);
  logDuration("ONNX embedding generation", start);
  return normalized;
}
