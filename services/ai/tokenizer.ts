import * as FileSystem from "expo-file-system/legacy";

const CLS_TOKEN = "[CLS]";
const SEP_TOKEN = "[SEP]";
const PAD_TOKEN = "[PAD]";
const UNK_TOKEN = "[UNK]";

/** BERT's WordPiece algorithm bails out to [UNK] rather than looping forever
 * on a pathological input (e.g. a URL with no whitespace). */
const MAX_INPUT_CHARS_PER_WORD = 100;

export type Vocab = Map<string, number>;

/** Parses a BERT-style vocab.txt — one token per line, line number == token id. */
export async function loadVocab(vocabPath: string): Promise<Vocab> {
  const text = await FileSystem.readAsStringAsync(vocabPath);
  const vocab: Vocab = new Map();
  text.split("\n").forEach((line, i) => {
    const token = line.replace(/\r$/, "");
    if (token) {
      vocab.set(token, i);
    }
  });
  return vocab;
}

/**
 * Lowercases, strips combining diacritics, and splits on whitespace/punctuation
 * — mirrors BERT's uncased BasicTokenizer (punctuation becomes its own token).
 */
function basicTokenize(text: string): string[] {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const tokens: string[] = [];
  let current = "";
  for (const ch of normalized) {
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
    } else if (/[\p{P}\p{S}]/u.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      tokens.push(ch);
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Greedy longest-match-first subword splitting — BERT's WordPiece algorithm. */
function wordpieceTokenize(word: string, vocab: Vocab): string[] {
  if (word.length > MAX_INPUT_CHARS_PER_WORD) {
    return [UNK_TOKEN];
  }

  const subTokens: string[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let matched: string | null = null;
    while (start < end) {
      const candidate = start > 0 ? `##${word.slice(start, end)}` : word.slice(start, end);
      if (vocab.has(candidate)) {
        matched = candidate;
        break;
      }
      end -= 1;
    }
    if (matched === null) {
      return [UNK_TOKEN];
    }
    subTokens.push(matched);
    start = end;
  }
  return subTokens;
}

export type Encoding = {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
};

/**
 * Tokenizes `text` into BERT-style input arrays, wrapped in [CLS]/[SEP] and
 * padded/truncated to exactly `maxLength` (required — ONNX Runtime expects
 * fixed-shape tensors matching the exported graph).
 */
export function encode(text: string, vocab: Vocab, maxLength: number): Encoding {
  const pieces = basicTokenize(text).flatMap((word) => wordpieceTokenize(word, vocab));

  const clsId = vocab.get(CLS_TOKEN) ?? 0;
  const sepId = vocab.get(SEP_TOKEN) ?? 0;
  const padId = vocab.get(PAD_TOKEN) ?? 0;
  const unkId = vocab.get(UNK_TOKEN) ?? 0;

  const maxPieces = Math.max(0, maxLength - 2); // room for [CLS] and [SEP]
  const ids = pieces.slice(0, maxPieces).map((piece) => vocab.get(piece) ?? unkId);

  const inputIds = [clsId, ...ids, sepId];
  const attentionMask = inputIds.map(() => 1);

  while (inputIds.length < maxLength) {
    inputIds.push(padId);
    attentionMask.push(0);
  }

  return {
    inputIds,
    attentionMask,
    tokenTypeIds: inputIds.map(() => 0),
  };
}
