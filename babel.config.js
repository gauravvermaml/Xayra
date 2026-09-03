module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // react-native-worklets' plugin (which react-native-reanimated 4.x's own
    // worklet transform now delegates to) MUST be listed last — it rewrites
    // every `worklet` function the bottom sheet's/waveform's Reanimated
    // animations use, and Babel plugin ordering means an earlier plugin
    // could otherwise see un-transformed worklet syntax.
    plugins: ["react-native-worklets/plugin"],
  };
};
