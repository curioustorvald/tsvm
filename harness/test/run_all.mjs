// harness/test/run_all.mjs -- run every t_*.mjs self-test; exit nonzero on any
// failure.  Usage: node harness/test/run_all.mjs
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runSuites } from "../index.mjs"

const TESTDIR = path.dirname(fileURLToPath(import.meta.url))
const ok = await runSuites(TESTDIR)
if (!ok) { console.error("FAILED"); process.exit(1) }
console.log("all harness self-tests passed")
