// harness/lib/context.mjs
//
// Builds the sandboxed JS context that mirrors a TSVM "js" VMRunner: it injects
// the host globals (sys/graphics/serial/gzip/base64/com/dma/audio/parallel),
// evaluates JS_INIT.js to install the base environment (con/print/println +
// ES6 polyfills), then layers the TVDOS userland (files/_TVDOS/_G/require).

import vm from "node:vm"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

import { VMMemory } from "./memory.mjs"
import { TTY } from "./tty.mjs"
import { makeSys } from "./sys.mjs"
import { makeGraphics } from "./graphics.mjs"
import { makeCompress } from "./compress.mjs"
import { makeDevices } from "./devices.mjs"
import { makeTvdos } from "./tvdos.mjs"
import { GPU_SLOT, GPU_TEXT_AREA_OFFSET } from "./memory.mjs"

const HARNESS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PROJECT_ROOT = path.dirname(HARNESS_DIR)
const JS_INIT_PATH = path.join(PROJECT_ROOT, "tsvm_core/src/net/torvald/tsvm/JS_INIT.js")

let vmCounter = 0

export function createVM(userOpts = {}) {
    const opts = {
        diskRoot: path.join(PROJECT_ROOT, "assets/disk0"),
        overlayRoot: fs.mkdtempSync(path.join(os.tmpdir(), "tsvm-harness-")),
        env: {},
        drives: {},
        applyCommandrc: undefined, // path to commandrc, or false to skip; default A:/commandrc
        tvdos: true, // install the TVDOS userland layer
        console: true, // expose host console inside the sandbox (harness convenience)
        strictInput: false, // readKey() throws on empty queue instead of returning -1
        realSleep: false, // sys.sleep / sys.spin actually busy-wait
        serialToStderr: false, // mirror serial debug output to the host stderr
        maxWaitSpins: 2_000_000, // bound for sys.waitForMemChg
        jsInitPath: JS_INIT_PATH,
        ...userOpts,
    }

    const mem = new VMMemory(opts)
    const tty = new TTY(mem.peripherals[GPU_SLOT].block, GPU_TEXT_AREA_OFFSET)

    const harnessVM = {
        id: ++vmCounter,
        opts,
        mem,
        tty,
        hooks: {},               // { print(str) } optional override
        inputQueue: mem.inputQueue,
        rawKeys: mem.rawKeys,
        serialOut: "",
        stubCalls: [],           // recorded com/audio calls
        roms: [],
        romMapping: 255,
        sysrqDown: false,

        // capture accessors
        get output() { return tty.output },
        outputText: () => tty.outputText(),
        screenText: () => tty.screenText(),
        clearOutput: () => { tty.output = "" },

        // input helpers
        feedKeys(arr) { for (const k of arr) mem.inputQueue.push(k | 0); return this },
        feedLine(str) { for (const ch of String(str)) mem.inputQueue.push(ch.charCodeAt(0) & 0xff); mem.inputQueue.push(13); return this },
        setRawKeys(bytes) { for (let i = 0; i < 8; i++) mem.rawKeys[i] = bytes[i] | 0; return this },
    }

    // ----- host delegates ---------------------------------------------------
    const sys = makeSys(harnessVM)
    const graphics = makeGraphics(harnessVM)
    const { gzip, base64 } = makeCompress(harnessVM)
    harnessVM.compress = gzip // used by sys.toObjectCode
    const { serial, dma, com, audio } = makeDevices(harnessVM)

    // ----- build the sandbox / context -------------------------------------
    const sandbox = {
        sys, graphics, serial, gzip, base64, com, dma, audio,
        parallel: makeParallelStub(harnessVM),
        // node:vm needs these to look like a normal global
        Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp,
        Error, TypeError, RangeError, Symbol, Map, Set, WeakMap, WeakSet,
        Promise, Function, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent,
        decodeURIComponent, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array,
        Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer,
        DataView, BigInt, Reflect, Proxy,
    }
    if (opts.console) sandbox.console = console
    sandbox.globalThis = sandbox

    const context = vm.createContext(sandbox, { name: `tsvm-vm-${harnessVM.id}` })
    harnessVM.context = context
    harnessVM.sandbox = sandbox

    // module evaluator used by TVDOS require() and vm.runModule()
    harnessVM.evalModule = (src, name = "module") => {
        const wrapped = `(function(){ let exports = {};\n${src}\n; return Object.freeze(exports); })()`
        return vm.runInContext(wrapped, context, { filename: name })
    }

    // ----- JS_INIT (base environment: con/print/polyfills) -----------------
    const jsInitSrc = fs.readFileSync(opts.jsInitPath, "latin1")
    vm.runInContext(jsInitSrc, context, { filename: "JS_INIT.js" })

    // ----- TVDOS userland ---------------------------------------------------
    if (opts.tvdos) {
        const { files, _TVDOS, _G, require } = makeTvdos(harnessVM)
        sandbox.files = files
        sandbox._TVDOS = _TVDOS
        sandbox._G = _G
        sandbox.require = require
        harnessVM.files = files
        harnessVM._TVDOS = _TVDOS
        harnessVM._G = _G
    }

    // ----- program runners --------------------------------------------------
    // executeCommand-style: strict IIFE wrapper (matches VMRunnerFactory)
    harnessVM.run = (src, filename = "program.js") =>
        vm.runInContext(`"use strict";(function(){${src}\n})()`, context, { filename })
    // raw eval in the global scope (define/inspect globals)
    harnessVM.eval = (src, filename = "eval.js") =>
        vm.runInContext(src, context, { filename })
    // run a module (TVDOS require contract) and return its exports
    harnessVM.runModule = (src, name = "module") => harnessVM.evalModule(src, name)
    // run a file from the host filesystem (path is a host path)
    harnessVM.runFile = (hostPath) => {
        const src = fs.readFileSync(hostPath, "latin1")
        return harnessVM.run(src, hostPath)
    }
    // run a file from the VM disk (e.g. "A:/tvdos/bin/foo.js")
    harnessVM.runDiskFile = (vmPath) => {
        if (!harnessVM.files) throw new Error("TVDOS layer disabled; enable opts.tvdos to use runDiskFile")
        const fd = harnessVM.files.open(vmPath)
        if (!fd.exists) throw new Error("No such file: " + vmPath)
        return harnessVM.run(fd.sread(), vmPath)
    }

    // cleanup the overlay temp dir (only if we created it)
    harnessVM.dispose = () => {
        if (!userOpts.overlayRoot && opts.overlayRoot.includes("tsvm-harness-")) {
            try { fs.rmSync(opts.overlayRoot, { recursive: true, force: true }) } catch {}
        }
    }

    return harnessVM
}

// parallel: a recording stub. True multi-context concurrency (vtmgr) is out of
// scope for the headless harness.
function makeParallelStub(vm) {
    return {
        spawnNewContext: () => ({ __stub: true }),
        attachProgram: (name) => ({ __stub: true, name }),
        launch: () => { vm.stubCalls.push({ ns: "parallel", method: "launch", args: [] }) },
        suspend: () => {},
        resume: () => {},
        kill: () => {},
        isRunning: () => false,
        getThreadPool: () => [],
    }
}
