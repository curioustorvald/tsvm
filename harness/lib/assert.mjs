// harness/lib/assert.mjs
//
// A tiny assertion kit + suite runner, in the same spirit as the DOOM test
// harness's makeT(). A test file exports `run()` (sync or async) returning a
// boolean; runSuites() discovers and runs every t_*.mjs in a directory.

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function makeT(suiteName) {
    let pass = 0, fail = 0
    const t = {
        ok(cond, msg) {
            if (cond) pass++
            else { fail++; console.error(`  FAIL ${suiteName}: ${msg}`) }
        },
        eq(a, b, msg) {
            t.ok(Object.is(a, b), `${msg} (got ${fmt(a)}, expected ${fmt(b)})`)
        },
        neq(a, b, msg) {
            t.ok(!Object.is(a, b), `${msg} (got ${fmt(a)}, expected != ${fmt(b)})`)
        },
        // assert that `s` contains substring `sub`
        contains(s, sub, msg) {
            t.ok(String(s).indexOf(sub) >= 0, `${msg} (${fmt(s)} does not contain ${fmt(sub)})`)
        },
        // assert that `fn` throws (optionally with message matching `re`)
        throws(fn, re, msg) {
            let threw = false, err
            try { fn() } catch (e) { threw = true; err = e }
            if (!threw) { fail++; console.error(`  FAIL ${suiteName}: ${msg} (did not throw)`); return }
            if (re && !re.test(String(err && err.message))) {
                fail++; console.error(`  FAIL ${suiteName}: ${msg} (threw ${fmt(err && err.message)}, expected /${re.source}/)`); return
            }
            pass++
        },
        report() {
            const ok = fail === 0
            console.log(`${ok ? "ok  " : "FAIL"} ${suiteName}: ${pass} passed, ${fail} failed`)
            return ok
        },
        get passed() { return pass },
        get failed() { return fail },
    }
    return t
}

function fmt(v) {
    if (typeof v === "string") return JSON.stringify(v.length > 80 ? v.slice(0, 80) + "..." : v)
    return String(v)
}

// Run every t_*.mjs in `dir` (each exporting `run(): boolean|Promise<boolean>`).
export async function runSuites(dir) {
    const suites = fs.readdirSync(dir)
        .filter((f) => f.startsWith("t_") && f.endsWith(".mjs"))
        .sort()
    let allOk = true
    for (const f of suites) {
        const mod = await import(pathToFileURL(path.join(dir, f)))
        if (typeof mod.run !== "function") { console.error(`  ${f}: no exported run()`); allOk = false; continue }
        const ok = await mod.run()
        if (!ok) allOk = false
    }
    return allOk
}
