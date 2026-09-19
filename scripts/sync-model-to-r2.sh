#!/usr/bin/env bash
#
# Pulls a GGUF model straight from Hugging Face and pushes it into the
# Cloudflare R2 bucket the app's CDN Worker serves from, so a production
# model swap never depends on Hugging Face being reachable from a user's
# device (or on its rate limits / redirect behaviour).
#
# WHY aws-cli AND NOT wrangler
# ----------------------------
# `wrangler r2 object put` has two traps that both cost real debugging time:
#   1. Without `--remote` it silently writes to a LOCAL dev-mode cache under
#      .wrangler/ and still prints "Upload complete" — the object never
#      reaches the real bucket.
#   2. With `--remote` it hard-fails above 300 MiB ("Wrangler only supports
#      uploading files up to 300 MiB in size"). Every model this repo ships
#      is larger than that.
# R2's S3-compatible endpoint handles multipart transparently, so the AWS CLI
# is the only sane path for multi-hundred-MB / multi-GB objects.
#
# PREREQUISITES
#   - aws CLI v2 configured with the R2 access key / secret for this account
#     (this machine already has them; `region = auto` in ~/.aws/config is the
#     giveaway that a profile is an R2 profile rather than a real AWS one).
#   - CLOUDFLARE_ACCOUNT_ID exported, or passed via --account-id.
#
# USAGE
#   ./scripts/sync-model-to-r2.sh \
#       --repo Qwen/Qwen2.5-1.5B-Instruct-GGUF \
#       --file qwen2.5-1.5b-instruct-q4_k_m.gguf
#
#   Defaults target the current production chat model, so a bare invocation
#   re-syncs exactly what the app ships today.

set -euo pipefail

HF_REPO="Qwen/Qwen2.5-1.5B-Instruct-GGUF"
HF_FILE="qwen2.5-1.5b-instruct-q4_k_m.gguf"
R2_BUCKET="xayra-models"
R2_KEY=""
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
WORKER_BASE="https://xayra-models-proxy.vermagauravsingh.workers.dev"
KEEP_LOCAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)       HF_REPO="$2"; shift 2 ;;
    --file)       HF_FILE="$2"; shift 2 ;;
    --bucket)     R2_BUCKET="$2"; shift 2 ;;
    --key)        R2_KEY="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --keep-local) KEEP_LOCAL=1; shift ;;
    -h|--help)    sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The object key defaults to the bare filename: the Worker is a plain
# object-key passthrough with no allowlist or rewriting, so whatever key is
# used here is exactly what MODEL_CDN_BASE_URL/<key> resolves to.
[[ -n "$R2_KEY" ]] || R2_KEY="$HF_FILE"

if [[ -z "$ACCOUNT_ID" ]]; then
  echo "ERROR: account id missing. Export CLOUDFLARE_ACCOUNT_ID or pass --account-id." >&2
  echo "       Recover it with: npx wrangler whoami" >&2
  exit 1
fi

command -v aws >/dev/null   || { echo "ERROR: aws CLI not found on PATH." >&2; exit 1; }
command -v curl >/dev/null  || { echo "ERROR: curl not found on PATH." >&2; exit 1; }

ENDPOINT="https://${ACCOUNT_ID}.r2.cloudflarestorage.com"
SRC_URL="https://huggingface.co/${HF_REPO}/resolve/main/${HF_FILE}?download=true"
WORKDIR="$(mktemp -d)"
LOCAL_PATH="${WORKDIR}/${HF_FILE}"

cleanup() {
  if [[ "$KEEP_LOCAL" -eq 0 ]]; then
    rm -rf "$WORKDIR"
  else
    echo "Local copy kept at: ${LOCAL_PATH}"
  fi
}
trap cleanup EXIT

echo "==> Source : ${HF_REPO}/${HF_FILE}"
echo "==> Target : r2://${R2_BUCKET}/${R2_KEY}"
echo "==> Endpoint: ${ENDPOINT}"
echo

echo "==> [1/4] Downloading from Hugging Face…"
# -L: HF serves the actual blob via a CDN redirect. --fail-with-body so an
# HTML error page is never silently written out as if it were a GGUF.
curl -L --fail-with-body --progress-bar -o "$LOCAL_PATH" "$SRC_URL"

echo "==> [2/4] Verifying the artifact is really a GGUF…"
# Guards against the classic failure where a 404/302 HTML page lands on disk
# under a .gguf name and only fails much later, on-device, inside initLlama().
MAGIC="$(head -c 4 "$LOCAL_PATH" | tr -d '\0')"
if [[ "$MAGIC" != "GGUF" ]]; then
  echo "ERROR: downloaded file does not start with the GGUF magic bytes (got '${MAGIC}')." >&2
  exit 1
fi
BYTES="$(wc -c < "$LOCAL_PATH" | tr -d '[:space:]')"
echo "    magic=GGUF  bytes=${BYTES}"

echo "==> [3/4] Uploading to R2 (multipart handled by aws-cli)…"
aws s3 cp "$LOCAL_PATH" "s3://${R2_BUCKET}/${R2_KEY}" \
  --endpoint-url "$ENDPOINT" \
  --content-type application/octet-stream

echo "==> [4/4] Confirming the Worker actually serves it…"
# The bucket accepting the object is not proof the CDN path works — this is
# the check that caught a whole 2 GB upload having gone to a local cache.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "${WORKER_BASE}/${R2_KEY}")"
if [[ "$STATUS" != "200" && "$STATUS" != "206" ]]; then
  echo "ERROR: Worker returned HTTP ${STATUS} for ${WORKER_BASE}/${R2_KEY}" >&2
  exit 1
fi

echo
echo "Done. Live at: ${WORKER_BASE}/${R2_KEY}"
echo "Bytes: ${BYTES}  <-- use this for the *_APPROX_BYTES constant in services/ai/modelDownloadManager.ts"
