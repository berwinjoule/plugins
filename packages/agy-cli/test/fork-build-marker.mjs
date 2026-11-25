import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

test("fork build stays on 0.1.120 and does not claim the production disk bytes", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  const mark = JSON.parse(readFileSync(path.join(root, "FORK_BUILD.json"), "utf8"))
  assert.equal(pkg.version, "0.1.120")
  assert.equal(pkg.magpie.forkBuild.baseVersion, "0.1.120")
  assert.equal(pkg.magpie.forkBuild.notOfficialRelease, true)
  assert.equal(mark.baseCommit, "e967ba4d946071c6c27a51cd5168b12ce832da5c")
  assert.equal(mark.publicIndexMatchesReportedProductionDisk, true)
  assert.equal(mark.candidateIndexMatchesProductionDisk, false)
  assert.equal(mark.wholeInstalledPackageMatchesProduction, "unknown")
  assert.equal(mark.loadedMemoryHash, "unknown")
  assert.ok(mark.obsoleteCandidates.includes("0.1.116"))
})
