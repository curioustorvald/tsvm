// harness/lib/tty.mjs
//
// A pragmatic port of the TSVM GPU TTY interpreter (GlassTty.acceptChar +
// GraphicsAdapter handlers). It is NOT pixel-accurate; its job is to:
//   1. capture everything written through print()/sys.print so tests can assert
//      on program output (vm.output / vm.outputText / vm.screenText), and
//   2. maintain an 80x32 text grid + cursor inside the GPU peripheral block's
//      text-area window, so graphics.getCursorYX()/clearText()/putSymbol() and
//      direct-VRAM (`vaddr`) reads see the same bytes a real GPU would hold.

export const TERM_COLS = 80
export const TERM_ROWS = 32

// text-area sub-plane offsets within the GPU block (relative to text-area base):
//   cursor(2) + fore(2560) + back(2560) + char(2560)
const CURSOR_OFF = 0
const FORE_OFF = 2
const BACK_OFF = 2 + TERM_COLS * TERM_ROWS
const CHAR_OFF = 2 + 2 * TERM_COLS * TERM_ROWS

export class TTY {
    constructor(gpuBlock, textAreaOffset) {
        this.block = gpuBlock
        this.base = textAreaOffset
        this.cols = TERM_COLS
        this.rows = TERM_ROWS

        this.cx = 0 // 0-based cursor column
        this.cy = 0 // 0-based cursor row
        this.fore = 239 // default-ish foreground colour index
        this.back = 255 // transparent/background
        this.cursorVisible = true

        // capture streams
        this.output = "" // literal print stream (control bytes & escapes included)
        this._escState = 0 // 0 normal, 1 saw ESC, 2 in CSI, 3 in \x84 emit-char
        this._escBuf = ""

        this._clearGrid()
    }

    // ----- text-area plane accessors ---------------------------------------
    _charIdx(x, y) { return this.base + CHAR_OFF + y * this.cols + x }
    _foreIdx(x, y) { return this.base + FORE_OFF + y * this.cols + x }
    _backIdx(x, y) { return this.base + BACK_OFF + y * this.cols + x }

    _putCellRaw(x, y, code) {
        this.block[this._charIdx(x, y)] = code & 0xff
        this.block[this._foreIdx(x, y)] = this.fore & 0xff
        this.block[this._backIdx(x, y)] = this.back & 0xff
    }

    _syncCursor() {
        this.block[this.base + CURSOR_OFF] = this.cx & 0xff
        this.block[this.base + CURSOR_OFF + 1] = this.cy & 0xff
    }

    _clearGrid() {
        for (let y = 0; y < this.rows; y++)
            for (let x = 0; x < this.cols; x++) this._putCellRaw(x, y, 0)
        this.cx = 0; this.cy = 0
        this._syncCursor()
    }

    // ----- scrolling / cursor motion ---------------------------------------
    _scrollUp() {
        const stride = this.cols
        const charB = this.base + CHAR_OFF, foreB = this.base + FORE_OFF, backB = this.base + BACK_OFF
        for (let y = 1; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                this.block[charB + (y - 1) * stride + x] = this.block[charB + y * stride + x]
                this.block[foreB + (y - 1) * stride + x] = this.block[foreB + y * stride + x]
                this.block[backB + (y - 1) * stride + x] = this.block[backB + y * stride + x]
            }
        }
        const last = this.rows - 1
        for (let x = 0; x < this.cols; x++) {
            this.block[charB + last * stride + x] = 0
            this.block[foreB + last * stride + x] = this.fore & 0xff
            this.block[backB + last * stride + x] = this.back & 0xff
        }
    }

    _newline() {
        this.cx = 0
        this.cy++
        if (this.cy >= this.rows) { this.cy = this.rows - 1; this._scrollUp() }
    }

    _advance() {
        this.cx++
        if (this.cx >= this.cols) this._newline()
    }

    _putPrintable(code) {
        this._putCellRaw(this.cx, this.cy, code)
        this._advance()
    }

    // ----- main entry -------------------------------------------------------
    write(s) {
        s = "" + s
        this.output += s
        for (let i = 0; i < s.length; i++) this._byte(s.charCodeAt(i) & 0xff)
        this._syncCursor()
    }

    _byte(b) {
        switch (this._escState) {
            case 1: // saw ESC
                if (b === 0x5b /* [ */) { this._escState = 2; this._escBuf = "" }
                else this._escState = 0
                return
            case 2: // inside CSI ... final byte in 0x40..0x7e
                if (b >= 0x40 && b <= 0x7e) { this._csi(this._escBuf, b); this._escState = 0 }
                else this._escBuf += String.fromCharCode(b)
                return
            case 3: // inside \x84 emit-char: digits then 'u'
                if (b === 0x75 /* u */) {
                    const code = parseInt(this._escBuf, 10)
                    if (!isNaN(code)) this._putPrintable(code & 0xff)
                    this._escState = 0
                } else this._escBuf += String.fromCharCode(b)
                return
        }
        // normal state
        switch (b) {
            case 0x1b: this._escState = 1; return // ESC
            case 0x84: this._escState = 3; this._escBuf = ""; return // emit-char escape
            case 10: this._newline(); return // \n
            case 13: this.cx = 0; return // \r
            case 8: if (this.cx > 0) this.cx--; return // backspace
            case 9: this.cx = Math.min(this.cols - 1, (this.cx + 8) & ~7); return // tab
            case 7: return // bell
            case 0: return
            default:
                if (b >= 0x20) this._putPrintable(b)
        }
    }

    _csi(params, finalByte) {
        const fb = String.fromCharCode(finalByte)
        const nums = params.split(";")
        const n = (i, dflt) => {
            const v = parseInt(nums[i], 10)
            return isNaN(v) ? dflt : v
        }
        switch (fb) {
            case "H": case "f": // cursor position (1-based)
                this.cy = Math.max(0, Math.min(this.rows - 1, n(0, 1) - 1))
                this.cx = Math.max(0, Math.min(this.cols - 1, n(1, 1) - 1))
                break
            case "A": this.cy = Math.max(0, this.cy - n(0, 1)); break
            case "B": this.cy = Math.min(this.rows - 1, this.cy + n(0, 1)); break
            case "C": this.cx = Math.min(this.cols - 1, this.cx + n(0, 1)); break
            case "D": this.cx = Math.max(0, this.cx - n(0, 1)); break
            case "J": if (n(0, 0) === 2) this._clearGrid(); break
            case "K": { // erase line (default: cursor to EOL)
                const mode = n(0, 0)
                const from = mode === 1 ? 0 : (mode === 2 ? 0 : this.cx)
                const to = mode === 1 ? this.cx : this.cols - 1
                for (let x = from; x <= to; x++) this._putCellRaw(x, this.cy, 0)
                break
            }
            case "m": this._sgr(nums); break
            case "h": case "l":
                if (params.indexOf("?25") >= 0) this.cursorVisible = (fb === "h")
                break
            default: break // swallow
        }
    }

    _sgr(nums) {
        for (let i = 0; i < nums.length; i++) {
            const v = parseInt(nums[i], 10) || 0
            if (v === 0) { this.fore = 239; this.back = 255 }
            else if (v === 7) { const t = this.fore; this.fore = this.back; this.back = t }
            else if (v >= 30 && v <= 37) this.fore = v - 30
            else if (v >= 40 && v <= 47) this.back = v - 40
            else if (v === 38 && nums[i + 1] === "5") { this.fore = parseInt(nums[i + 2], 10) || 0; i += 2 }
            else if (v === 48 && nums[i + 1] === "5") { this.back = parseInt(nums[i + 2], 10) || 0; i += 2 }
        }
    }

    // ----- direct GPU delegate operations ----------------------------------
    putSymbol(code) { // does NOT advance (matches graphics.putSymbol)
        this._putCellRaw(this.cx, this.cy, code)
        this._syncCursor()
    }
    putSymbolAt(y, x, code) {
        if (y >= 0 && y < this.rows && x >= 0 && x < this.cols) this._putCellRaw(x, y, code)
    }
    clearText() { this._clearGrid() }
    setCursor(y, x) { // 0-based
        this.cy = Math.max(0, Math.min(this.rows - 1, y | 0))
        this.cx = Math.max(0, Math.min(this.cols - 1, x | 0))
        this._syncCursor()
    }
    getCursor() { return [this.cy, this.cx] } // 0-based [row, col]

    // ----- capture rendering ------------------------------------------------
    // literal stream with ESC/CSI sequences and the \x84..u escape stripped,
    // control bytes other than \n removed -- a readable transcript.
    outputText() {
        let out = ""
        const s = this.output
        let i = 0
        while (i < s.length) {
            const b = s.charCodeAt(i)
            if (b === 0x1b) { // skip ESC [ ... final
                i++
                if (s.charCodeAt(i) === 0x5b) { i++; while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++; i++ }
                continue
            }
            if (b === 0x84) { // \x84<decimal>u -> the char
                i++; let num = ""
                while (i < s.length && s[i] !== "u") { num += s[i]; i++ }
                i++
                const code = parseInt(num, 10)
                if (!isNaN(code)) out += String.fromCharCode(code & 0xff)
                continue
            }
            if (b === 10) { out += "\n"; i++; continue }
            if (b >= 0x20) out += s[i]
            i++
        }
        return out
    }

    // render the current 80x32 grid as text (trailing blanks trimmed per row)
    screenText() {
        const lines = []
        for (let y = 0; y < this.rows; y++) {
            let line = ""
            for (let x = 0; x < this.cols; x++) {
                const c = this.block[this._charIdx(x, y)]
                line += c === 0 ? " " : String.fromCharCode(c)
            }
            lines.push(line.replace(/\s+$/, ""))
        }
        // trim trailing empty rows
        while (lines.length && lines[lines.length - 1] === "") lines.pop()
        return lines.join("\n")
    }

    reset() { this.output = ""; this._clearGrid(); this.fore = 239; this.back = 255 }
}
