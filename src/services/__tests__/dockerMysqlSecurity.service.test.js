import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

// Path is relative to this test file: __tests__ -> services -> src -> repo root.
const compose = await readFile(
  new URL("../../../docker-compose.yml", import.meta.url),
  "utf8"
)

test("published MySQL port is bound only to localhost", () => {
  assert.match(compose, /127\.0\.0\.1:3306:3306/)
  assert.doesNotMatch(compose, /-\s*["']?3306:3306["']?\s*$/m)
})

test("container-internal database networking and persistent storage remain unchanged", () => {
  assert.match(compose, /PMA_HOST:\s*db/)
  assert.match(compose, /PMA_PORT:\s*3306/)
  assert.match(compose, /mysql-data:\/var\/lib\/mysql/)
})
