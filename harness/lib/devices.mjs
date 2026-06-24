// harness/lib/devices.mjs
//
// The remaining host globals:
//   serial -- VMSerialDebugger (debug print, captured into vm.serialOut)
//   dma    -- DMADelegate; the RAM<->RAM / str->RAM / RAM<->frame moves are real
//             (backed by VMMemory); the serial-port transfers throw, because
//             disk I/O in the harness goes through the `files` layer, not com.
//   com    -- SerialHelperDelegate (network/modem): recording stub
//   audio  -- AudioJSR223Delegate: recording stub (records every call into
//             vm.stubCalls so tests can assert on what the program asked for)

// A stub whose every method records {name, args} into vm.stubCalls and returns
// a per-method default (or undefined). Lets arbitrary TVDOS apps run without a
// real peripheral while letting tests inspect the calls.
function recordingStub(vm, ns, defaults = {}) {
    const target = {}
    return new Proxy(target, {
        get(_t, prop) {
            if (prop === Symbol.toPrimitive || prop === "then") return undefined
            if (typeof prop === "symbol") return undefined
            return (...args) => {
                vm.stubCalls.push({ ns, method: prop, args })
                const d = defaults[prop]
                return typeof d === "function" ? d(...args) : d
            }
        },
    })
}

export function makeDevices(vm) {
    const mem = vm.mem

    // ----- serial (debug console) ------------------------------------------
    const serial = {
        print: (s) => { vm.serialOut += String(s); if (vm.opts.serialToStderr) process.stderr.write(String(s)) },
        println: (s) => { vm.serialOut += String(s) + "\n"; if (vm.opts.serialToStderr) process.stderr.write(String(s) + "\n") },
        printerr: (s) => { vm.serialOut += String(s) + "\n"; if (vm.opts.serialToStderr) process.stderr.write(String(s) + "\n") },
    }

    // ----- dma --------------------------------------------------------------
    const serialOnly = (name) => () => {
        throw new Error(`dma.${name}() talks to a serial device; in the harness disk I/O goes through the files API. ` +
            `Use files.open(...).pread/pwrite instead, or test the surrounding logic.`)
    }
    const dma = {
        ramToRam: (from, to, length) => mem.memcpy(from | 0, to | 0, length | 0),
        strToRam: (str, to, srcOff, length) => {
            str = "" + str
            for (let i = 0; i < (length | 0); i++) mem.poke((to | 0) + i, str.charCodeAt((srcOff | 0) + i) & 0xff)
        },
        // 3-arg RAM<->frame moves are plain memcpy into/out of the GPU block.
        // (The 4-arg devnum overloads target a serial-bus remote framebuffer
        // and are not modelled in the harness.)
        ramToFrame: (from, to, length) => mem.memcpy(from | 0, to | 0, length | 0),
        ramToFrame2: (from, to, length) => mem.memcpy(from | 0, to | 0, length | 0),
        frameToRam: (from, to, length) => mem.memcpy(from | 0, to | 0, length | 0),
        comToRam: serialOnly("comToRam"),
        ramToCom: serialOnly("ramToCom"),
    }

    // ----- com (network / modem) -------------------------------------------
    const com = recordingStub(vm, "com", {
        getStatusCode: () => 0,
        areYouThere: () => false,
        waitUntilReady: () => {},
        getDeviceStatus: () => 0,
        pullMessage: () => "",
        fetchResponse: () => "",
        sendMessageGetBytes: () => new Uint8Array(0),
    })

    // ----- audio ------------------------------------------------------------
    const audio = recordingStub(vm, "audio", {
        getFreePlayhead: (fallback) => fallback | 0,
        isPcmMode: () => false,
        isTrackerMode: () => true,
        isPlaying: () => false,
        getMasterVolume: () => 255,
        getMasterPan: () => 128,
        getBPM: () => 120,
        getTickRate: () => 6,
        getPosition: () => 0,
        getCuePosition: () => 0,
        getTrackerRow: () => 0,
        getActiveNoteCounts: () => [],
        getSongGlobalVolume: () => 64,
        getSongMixingVolume: () => 48,
        getVoiceMute: () => false,
        // Models AudioJSR223Delegate.pollTrackerInterrupts: drain-on-read of the per-playhead
        // interrupt-note latch. Tests stage fires with vm.fireTrackerInterrupt(playhead, intNum).
        pollTrackerInterrupts: (ph) => {
            const q = vm.pendingTrackerInterrupts
            if (!q) return 0
            const m = (q[ph] | 0) & 0xFFFF
            q[ph] = 0
            return m
        },
    })

    return { serial, dma, com, audio }
}
