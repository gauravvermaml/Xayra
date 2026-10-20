/**
 * Gate B correction: concurrent Tier 1 is off by default; only the
 * emulator-only Xayra Test package can switch it on (for experiments).
 */
let mockPackage = "com.anonymous.silentconfidant";
const mockFiles = new Map<string, string>();
jest.mock("expo-app-signature", () => ({ getRuntimePackageName: () => mockPackage }), { virtual: true });
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///doc/",
  getInfoAsync: jest.fn((p: string) => Promise.resolve({ exists: mockFiles.has(p) })),
  readAsStringAsync: jest.fn((p: string) => Promise.resolve(mockFiles.get(p))),
  writeAsStringAsync: jest.fn((p: string, v: string) => Promise.resolve(void mockFiles.set(p, v))),
  deleteAsync: jest.fn((p: string) => Promise.resolve(void mockFiles.delete(p))),
}));

type Config = typeof import("../services/ai/tier1Config");
let config: Config;

beforeEach(() => {
  jest.resetModules();
  mockFiles.clear();
  config = require("../services/ai/tier1Config") as Config;
});

describe("concurrent Tier 1 default", () => {
  it("is off in the production package, and can't be switched there", async () => {
    mockPackage = "com.anonymous.silentconfidant";
    await config.loadTier1Config();
    expect(config.isConcurrentTier1Enabled()).toBe(false);
    expect(await config.setConcurrentTier1ForXayraTest(true)).toBe(false);
    expect(config.isConcurrentTier1Enabled()).toBe(false);
  });

  it("is off in Xayra Test until switched on, and persists the switch", async () => {
    mockPackage = "com.anonymous.silentconfidant.devtest";
    await config.loadTier1Config();
    expect(config.isConcurrentTier1Enabled()).toBe(false);
    expect(await config.setConcurrentTier1ForXayraTest(true)).toBe(true);
    jest.resetModules();
    config = require("../services/ai/tier1Config") as Config;
    await config.loadTier1Config();
    expect(config.isConcurrentTier1Enabled()).toBe(true);
    await config.setConcurrentTier1ForXayraTest(false);
    expect(mockFiles.size).toBe(0); // back to the default: no file
  });
});
