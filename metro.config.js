// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Registers ONNX model binaries as bundler assets (analogous to whisper.rn's
// GGML files) so `require("./model.onnx")` resolves like any other asset —
// in practice these are still loaded from the document directory at runtime
// (see services/ai/localEmbeddings.ts) rather than bundled, since a
// multi-MB model `require()`d into the app bundle would bloat every build;
// this just keeps the option open without forcing it.
config.resolver.assetExts.push("onnx", "ort");

module.exports = config;
