#!/usr/bin/env node
// harness/cli.mjs -- run a JS program inside the TSVM/TVDOS environment.
//
// Usage:
//   node harness/cli.mjs <file.js> [program args...]
//   node harness/cli.mjs A:/tvdos/bin/foo.js          (read from the VM disk)
//
// Options (before the file):
//   --keys "abc"        feed these characters to the input queue (then Enter)
//   --no-tvdos          skip the TVDOS userland (raw TSVM globals only)
//   --module            evaluate the file as a TVDOS module and print exports
//   --screen            after running, print the 80x32 text screen
//   --serial            mirror serial debug output to stderr
//   --disk <dir>        use <dir> as drive A: (default assets/disk0)
//   --raw               print the literal output stream (default: cleaned text)
//   --quiet             do not echo program output (only --screen / exit code)
//
// The program's `exec_args` global is set to [name, ...args] for TVDOS apps.

import fs from "node:fs"
import path from "node:path"
import { createVM } from "./lib/context.mjs"

function main(argv) {
    const opts = { tvdos: true }
    let keys = null, asModule = false, showScreen = false, raw = false, quiet = false
    let i = 0
    const rest = []
    while (i < argv.length) {
        const a = argv[i]
        if (a === "--keys") { keys = argv[++i] }
        else if (a === "--no-tvdos") { opts.tvdos = false }
        else if (a === "--module") { asModule = true }
        else if (a === "--screen") { showScreen = true }
        else if (a === "--serial") { opts.serialToStderr = true }
        else if (a === "--raw") { raw = true }
        else if (a === "--quiet") { quiet = true }
        else if (a === "--disk") { opts.diskRoot = path.resolve(argv[++i]) }
        else { rest.push(a) }
        i++
    }
    if (rest.length === 0) {
        console.error("usage: node harness/cli.mjs [options] <file.js> [args...]")
        process.exit(2)
    }

    const file = rest[0]
    const progArgs = rest.slice(1)
    const vm = createVM(opts)

    // expose program args the way TVDOS apps expect
    vm.sandbox.exec_args = [path.basename(file), ...progArgs]
    vm.sandbox.exec_args_concat = progArgs.join(" ")
    if (keys != null) vm.feedLine(keys)

    let exitCode = 0
    try {
        let result
        const isDisk = /^[A-Za-z]:/.test(file)
        const src = isDisk ? vm.files.open(file).sread() : fs.readFileSync(file, "latin1")
        if (asModule) {
            result = vm.runModule(src, file)
            if (!quiet) console.log("exports:", result)
        } else {
            vm.run(src, file)
        }
    } catch (e) {
        process.stderr.write(`\n[harness] program threw: ${e && e.stack ? e.stack : e}\n`)
        exitCode = 1
    }

    if (!quiet) process.stdout.write(raw ? vm.output : vm.outputText())
    if (showScreen) {
        process.stdout.write("\n----- screen (80x32) -----\n")
        process.stdout.write(vm.screenText() + "\n")
    }
    vm.dispose()
    process.exit(exitCode)
}

main(process.argv.slice(2))
