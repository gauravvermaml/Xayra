/**
 * Gate 2: every route under app/ is reachable by deep link in production, so
 * each developer/test screen must refuse to render its tools outside a
 * development build (Xayra Dev / Xayra Test / __DEV__).
 */
import fs from "fs";
import path from "path";

const DEV_ROUTES: Record<string, RegExp> = {
  "design-sandbox.tsx": /if \(!isDevelopmentBuild\(\)\)/,
  "design-system.tsx": /if \(!isDevelopmentBuild\(\)\)/,
  "dev-seed.tsx": /if \(!__DEV__\)/,
  "dev-vault.tsx": /if \(!devPackage\)/,
  "dev-mic-harness.tsx": /isMicHarnessAvailable\(\)/,
};

const appDir = path.join(__dirname, "..", "app");

describe("developer routes are guarded in production builds", () => {
  it("every dev/design route is listed here (a new one must add its guard)", () => {
    const routes = fs.readdirSync(appDir).filter((f) => /^(dev-|design-)/.test(f));
    expect(routes.sort()).toEqual(Object.keys(DEV_ROUTES).sort());
  });

  it.each(Object.entries(DEV_ROUTES))("%s checks its build/package guard", (file, guard) => {
    const source = fs.readFileSync(path.join(appDir, file), "utf8");
    expect(source).toMatch(guard);
  });
});
