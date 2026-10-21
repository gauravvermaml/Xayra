#!/usr/bin/env node
/**
 * Repository policy checks for CI. No dependencies, no network.
 *
 * - The release gate is blocked. With --require-closed (main, or a pull
 *   request into main) it must also carry no build-window exception: a
 *   window is opened and closed on a release branch, never left on main.
 * - .easignore contains every rule in .gitignore. EAS reads .easignore
 *   INSTEAD of .gitignore, so a rule missing there would upload ignored
 *   files (local keys, models, docs/) to the build server.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const requireClosed = process.argv.includes("--require-closed");
const failures = [];

const gate = JSON.parse(fs.readFileSync(path.join(root, "release-gate.json"), "utf8"));
if (gate.productionBlocked !== true) {
  failures.push("release-gate.json: productionBlocked must be true.");
}
if (requireClosed && "internalTestingBuild" in gate) {
  failures.push("release-gate.json: a build-window exception (internalTestingBuild) must not reach main.");
}

const rules = (file) =>
  fs
    .readFileSync(path.join(root, file), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
const easRules = new Set(rules(".easignore"));
const missing = rules(".gitignore").filter((rule) => !easRules.has(rule));
if (missing.length > 0) {
  failures.push(`.easignore is missing .gitignore rules: ${missing.join(", ")}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(`✓ release gate blocked${requireClosed ? ", no build window" : ""}; .easignore covers .gitignore`);
