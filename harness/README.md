# TSVM / TVDOS Node Test Harness

Run TSVM/TVDOS JavaScript **headlessly under Node.js** — no GraalVM, no LibGDX,
no window — so you can unit-test logic-heavy programs and modules automatically
(and let coding agents iterate without launching the emulator).

It reproduces the environment a real TSVM `js` VMRunner sets up:

| Layer | Source it mirrors | Notes |
|-------|-------------------|-------|
| `sys` | `VMJSR223Delegate.kt` | 8 MiB user space, 64-byte first-fit `malloc`, `peek/poke`, `memcpy`, `pokeBytes`, `print`, timers |
| `graphics` | `GraphicsJSR223Delegate.kt` | text plane + cursor + flat framebuffer; image/iPF/TEV/TAV codecs **throw** (native-only) |
| `gzip` / `base64` | `CompressorDelegate.kt` / `Base64Delegate.kt` | `gzip` is **Zstd** (Node native), gzip-wrapped payloads also decode |
| `serial`, `dma`, `com`, `audio` | resp. delegates | `dma` RAM moves are real; `com`/`audio` are **recording stubs** |
| `con`, `print`, polyfills | `JS_INIT.js` | evaluated verbatim from the repo |
| `files`, `_TVDOS`, `_G.shell`, `require` | `TVDOS.SYS` / `command.js` | backed by the real `assets/disk0`, **writes go to an overlay** |

Requires **Node ≥ 22.15** (for built-in Zstd in `node:zlib`).

## Quick start

```js
import { createVM } from "./harness/index.mjs"

const vm = createVM()
vm.run(`
  const p = sys.malloc(16)
  sys.poke(p, 65)
  println("hello, byte=" + sys.peek(p))
`)
console.log(vm.outputText())   // "hello, byte=65\n"
vm.dispose()
```

## CLI

```bash
node harness/cli.mjs [options] <file.js> [program args...]
node harness/cli.mjs A:/tvdos/bin/foo.js           # read from the VM disk
```

Options: `--keys "text"` (feed input), `--no-tvdos`, `--module` (eval as a TVDOS
module and print exports), `--screen` (dump the 80×32 text screen after), `--raw`
(literal output incl. escapes), `--serial` (mirror serial debug to stderr),
`--disk <dir>` (use a different drive A:), `--quiet`.

The program sees `exec_args = [name, ...args]` like a TVDOS app.

## `createVM(opts)` → vm

Common `opts`:

| opt | default | meaning |
|-----|---------|---------|
| `diskRoot` | `assets/disk0` | host dir mapped to drive `A:` |
| `overlayRoot` | a temp dir | where writes land (auto-removed by `dispose()` if defaulted) |
| `tvdos` | `true` | install `files`/`_TVDOS`/`_G`/`require` |
| `env` | `{}` | extra `_TVDOS.variables` |
| `strictInput` | `false` | `readKey()` throws on empty queue instead of returning `-1` |
| `realSleep` | `false` | make `sys.sleep`/`spin` actually busy-wait |
| `serialToStderr` | `false` | mirror `serial.*` debug output to host stderr |
| `console` | `true` | expose host `console` in the sandbox (harness aid) |

### vm methods & properties

- `vm.run(src)` — execute like `executeCommand` (strict IIFE wrapper).
- `vm.eval(src)` — eval in the global scope (define / inspect globals).
- `vm.runModule(src)` — eval under the TVDOS `require` contract; returns frozen exports.
- `vm.runFile(hostPath)` / `vm.runDiskFile("A:/...")` — run a file.
- `vm.output` — literal print stream; `vm.outputText()` — escapes/CSI stripped;
  `vm.screenText()` — the 80×32 grid rendered as text; `vm.clearOutput()`.
- `vm.feedKeys([codes])`, `vm.feedLine("str")`, `vm.setRawKeys([8 bytes])` — input.
- `vm.stubCalls` — recorded `com`/`audio`/`parallel` calls (`{ns, method, args}`).
- `vm.fireTrackerInterrupt(playhead, intNum)` — stage a Taud interrupt note (Int0..IntF)
  so the next `audio.pollTrackerInterrupts(playhead)` drains it (models the engine latch).
- `vm.serialOut` — captured serial debug text.
- `vm.sandbox` — the live globals (`sys`, `con`, `files`, `require`, …).
- `vm.mem`, `vm.tty` — the underlying memory model and TTY.
- `vm.dispose()` — remove the temp overlay.

## Writing tests

```js
import { createVM, makeT } from "./harness/index.mjs"

export function run() {           // each t_*.mjs exports run() -> boolean
  const t = makeT("my-feature")
  const vm = createVM()
  vm.run(`/* ... */`)
  t.eq(vm.outputText(), "expected\n", "it prints the thing")
  t.contains(vm.serialOut, "debug", "logs a debug line")
  t.throws(() => vm.run(`sys.peek(-99999999)`), /OpenBus/, "bad peek throws")
  vm.dispose()
  return t.report()
}
```

`makeT(name)` gives `ok/eq/neq/contains/throws/report`. `runSuites(dir)` (and
`test/run_all.mjs`) discover and run every `t_*.mjs`. Run the harness's own
suite with:

```bash
cd harness && node test/run_all.mjs
```

## What is faithful, and what is not

**Faithful (byte-level where it matters):** user-space memory + the `malloc`
allocator (reserved blocks, 64-byte units, first-fit reuse), peripheral negative
addressing including the GPU text-area `vaddr` pattern, Zstd/gzip + base64, the
`files` descriptor API and `_G.shell.resolvePathInput` (quirks and all), the
`require` module contract, and the `con`/`print` TTY escapes (`\x84..u`, CSI
moves/erase/SGR, `?25`).

**Stubbed or adapted (by design — pragmatic harness):**

- `graphics` image decode + iPF/TEV/TAV codecs throw a clear "not available in
  harness" error (they call native Kotlin). Test the JS logic around them.
- `audio`, `com`, `parallel` are recording stubs — calls are logged into
  `vm.stubCalls`, getters return safe defaults; there is no real DSP/network/
  threading. (vtmgr-style true concurrency is out of scope.)
- `sys.sleep`/`spin` are no-ops unless `realSleep`; `readKey` reads `vm.inputQueue`
  instead of blocking; `waitForMemChg` is **bounded** and throws if the condition
  never holds (nothing writes memory concurrently in a single-threaded harness).
- Host byte arrays returned by `gzip.decomp`/`base64.atob` are **unsigned**
  `Uint8Array` (GraalVM would surface signed `byte[]`); TVDOS's `btostr` handles
  both, so this is transparent in practice.
- The sandbox is plain JS, so `sys`/`graphics`/etc. **can** be overridden from JS
  (on the real machine they are immutable host objects). Handy for shimming.

## Files

```
harness/
  index.mjs        public API: createVM, makeT, runSuites
  cli.mjs          command-line runner
  lib/memory.mjs   VMMemory: user space + malloc + peripheral addressing
  lib/tty.mjs      TTY interpreter -> text-area planes + capture
  lib/sys.mjs      sys delegate
  lib/graphics.mjs graphics delegate (headless)
  lib/compress.mjs gzip (Zstd) + base64
  lib/devices.mjs  serial / dma / com / audio
  lib/tvdos.mjs    files / _TVDOS / _G.shell / require (overlay-backed)
  lib/context.mjs  builds the node:vm sandbox, loads JS_INIT, wires it together
  lib/assert.mjs   makeT + runSuites
  test/            self-tests (t_*.mjs)
```
