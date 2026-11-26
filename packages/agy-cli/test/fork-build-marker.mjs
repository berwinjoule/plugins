import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

test("fork build publishes 0.1.139-fork.1 and does not claim official 0.1.140", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  const mark = JSON.parse(readFileSync(path.join(root, "FORK_BUILD.json"), "utf8"))
  assert.equal(pkg.version, "0.1.139-fork.1")
  assert.notEqual(pkg.version, "0.1.139")
  assert.notEqual(pkg.version, "0.1.140")
  assert.equal(pkg.magpie.forkBuild.baseVersion, "0.1.139")
  assert.equal(pkg.magpie.forkBuild.npmVersion, "0.1.139-fork.1")
  assert.equal(pkg.magpie.forkBuild.notOfficialRelease, true)
  assert.equal(mark.officialVersionClaimed, "0.1.139")
  assert.equal(mark.npmVersion, "0.1.139-fork.1")
  assert.equal(mark.notOfficialRelease, true)
  assert.equal(mark.doesNotClaim, "0.1.140")
  assert.equal(mark.baseCommit, "5d9c08fca0d34472f032a3555e7ed30d06ff81dc")
  assert.equal(mark.baseVersion, "0.1.139")
  assert.equal(mark.publicIndexMatchesReportedProductionDisk, false)
  assert.equal(mark.candidateIndexMatchesProductionDisk, false)
  assert.equal(mark.wholeInstalledPackageMatchesProduction, "unknown")
  assert.equal(mark.loadedMemoryHash, "unknown")
  assert.equal(mark.productionPin, "4d273930f15aeb24042c18e1bdc5d914344e3f70")
  assert.ok(mark.obsoleteCandidates.includes("0.1.116"))
  assert.ok(mark.obsoleteCandidates.includes("0.1.121-fork.1"))
  assert.ok(mark.obsoleteCandidates.includes("0.1.134-fork.1"))
  assert.ok(pkg.files.includes("FORK_BUILD.json"))
})
