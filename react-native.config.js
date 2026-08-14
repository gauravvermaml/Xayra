// onnxruntime-react-native ships an app.plugin.js (Gradle/Podfile dependency
// wiring only — not native-module registration). Expo's autolinking treats
// any package with an app.plugin.js as "self-handled" and skips it from the
// classic community-autolinking pass that generates PackageList.java, so
// OnnxruntimeModule never got registered on the bridge despite its native
// code compiling fine (NativeModules.Onnxruntime was null at runtime,
// crashing on `Module.install()`). Declaring it explicitly here forces
// autolinking to include it regardless of that heuristic.
module.exports = {
  dependencies: {
    "onnxruntime-react-native": {
      platforms: {
        android: {
          sourceDir: "android",
          packageImportPath: "import ai.onnxruntime.reactnative.OnnxruntimePackage;",
          packageInstance: "new OnnxruntimePackage()",
        },
      },
    },
  },
};
