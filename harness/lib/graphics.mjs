// harness/lib/graphics.mjs
//
// The `graphics` global -- headless port of GraphicsJSR223Delegate.kt. Text /
// cursor operations go through the shared TTY (so con.* and direct-VRAM reads
// agree); the framebuffer is a flat 560x448 byte plane inside the GPU block.
// Image decoders and the iPF/TEV/TAV codecs are NOT ported -- they call into
// native Kotlin and will throw a clear "not available in harness" error.

import { GPU_SLOT, GPU_TEXT_AREA_OFFSET } from "./memory.mjs"

const FB_WIDTH = 560
const FB_HEIGHT = 448
const FB_SIZE = FB_WIDTH * FB_HEIGHT // 250880, 1 byte/pixel

const notImpl = (name) => () => {
    throw new Error(`graphics.${name}() is not available in the Node harness ` +
        `(it calls native Kotlin image/codec code). Test the pure-JS logic around it instead.`)
}

export function makeGraphics(vm) {
    const tty = vm.tty
    const gpu = vm.mem.peripherals[GPU_SLOT].block
    const fb = gpu.subarray(0, FB_SIZE) // framebuffer plane

    let graphicsMode = 0
    const palette = new Uint8Array(256 * 4)

    const g = {
        getGpuMemBase: () => -1 - (1048576 * GPU_SLOT), // -1048577
        getVramSize: () => {},

        getPixelDimension: () => [FB_WIDTH, FB_HEIGHT],
        getTermDimension: () => [tty.rows, tty.cols], // [rows, cols] = [32, 80]

        getCursorYX: () => { const [cy, cx] = tty.getCursor(); return [cy + 1, cx + 1] },
        setCursorYX: (cy, cx) => tty.setCursor((cy | 0) - 1, (cx | 0) - 1),

        // ----- text colours / cursor (text-area attribute defaults) ---------
        setTextFore: (b) => { tty.fore = b & 0xff },
        setTextBack: (b) => { tty.back = b & 0xff },
        getTextFore: () => tty.fore,
        getTextBack: () => tty.back,

        // ----- text plane operations ----------------------------------------
        putSymbol: (c) => tty.putSymbol(c | 0),
        putSymbolAt: (cy, cx, c) => tty.putSymbolAt(cy | 0, cx | 0, c | 0),
        clearText: () => tty.clearText(),

        // ----- framebuffer --------------------------------------------------
        plotPixel: (x, y, colour) => {
            x |= 0; y |= 0
            if (x >= 0 && x < FB_WIDTH && y >= 0 && y < FB_HEIGHT) fb[y * FB_WIDTH + x] = colour & 0xff
        },
        plotPixel2: (x, y, colour) => g.plotPixel(x, y, colour),
        plotRect: (x, y, w, h, colour) => {
            x |= 0; y |= 0; w |= 0; h |= 0
            for (let yy = y; yy < y + h; yy++) {
                if (yy < 0 || yy >= FB_HEIGHT) continue
                for (let xx = x; xx < x + w; xx++) {
                    if (xx < 0 || xx >= FB_WIDTH) continue
                    fb[yy * FB_WIDTH + xx] = colour & 0xff
                }
            }
        },
        clearPixels: (col) => fb.fill(col & 0xff),
        clearPixels2: (col) => fb.fill(col & 0xff),
        clearPixels3: (col) => fb.fill(col & 0xff),
        clearPixels4: (col) => fb.fill(col & 0xff),
        clearPixelsAll: (c1) => fb.fill(c1 & 0xff),
        getFramebuffer: () => fb, // harness convenience (not on real machine)

        setFramebufferScroll: () => {},
        getFramebufferScroll: () => [0, 0],
        scrollFrame: () => {},
        setLineOffset: () => {},
        getLineOffset: () => 0,

        // ----- modes / palette ----------------------------------------------
        setGraphicsMode: (mode) => { graphicsMode = mode | 0 },
        getGraphicsMode: () => graphicsMode,
        setBackground: () => {},
        resetPalette: () => palette.fill(0),
        setPalette: (index, r, gg, b, a = 15) => {
            const i = (index & 0xff) * 4
            palette[i] = r & 0xff; palette[i + 1] = gg & 0xff; palette[i + 2] = b & 0xff; palette[i + 3] = a & 0xff
        },

        // ----- native-only: image decode + iPF/TEV/TAV codecs ---------------
        decodeImage: notImpl("decodeImage"),
        decodeImageTo: notImpl("decodeImageTo"),
        decodeImageResample: notImpl("decodeImageResample"),
        decodeImageResampleTo: notImpl("decodeImageResampleTo"),
        imageToDisplayableFormat: notImpl("imageToDisplayableFormat"),
        imageToDirectCol: notImpl("imageToDirectCol"),
        encodeIpf1: notImpl("encodeIpf1"),
        encodeIpf1d: notImpl("encodeIpf1d"),
        encodeIpf2: notImpl("encodeIpf2"),
        decodeIpf1: notImpl("decodeIpf1"),
        decodeIpf2: notImpl("decodeIpf2"),
        applyIpf1d: notImpl("applyIpf1d"),
        decodeIpf1Progressive: notImpl("decodeIpf1Progressive"),
        decodeIpf2Progressive: notImpl("decodeIpf2Progressive"),
        tevDecode: notImpl("tevDecode"),
        tevIdct8x8: notImpl("tevIdct8x8"),
        tevMotionCopy8x8: notImpl("tevMotionCopy8x8"),
    }

    return g
}
