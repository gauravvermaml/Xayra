/**
 * Phase 1 QA stabilization (qa/06-phase-execution-roadmap.md): minimal Jest
 * setup for locking in the Phase 1 P0/P1 fixes. `jest-expo` handles
 * Expo/React-Native-aware transform config out of the box. Scoped to
 * services/db pure logic and mocked-native-module suites only — no RNTL, no
 * Maestro in this phase (see the roadmap for why those wait for Phase 2).
 */
module.exports = {
  preset: "jest-expo",
  testPathIgnorePatterns: ["/node_modules/", "/android/", "/dist/", "/__tests__/support/"],
  // jest-expo's own default already exempts the RN/Expo ecosystem from
  // CommonJS-only transformation; @op-engineering/op-sqlite ships ESM and
  // needs the same treatment so db/client.ts (imported transitively by
  // db-client-serialization.test.ts) can load under Jest.
  transformIgnorePatterns: [
    "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@op-engineering))",
  ],
};
