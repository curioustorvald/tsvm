if (exec_args[1] == undefined) {
    println("decodeipf <input.ipf>")
    return 1
}

const interactive = exec_args[2] && exec_args[2].toLowerCase() == "-i"
let infile = files.open(_G.shell.resolvePathInput(exec_args[1]).full)

// read input file
let infilePtr = sys.malloc(infile.size)
infile.pread(infilePtr, infile.size, 0)

// check if magic number matches

const MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x69, 0x50, 0x46]
let magicMatching = true

MAGIC.forEach((b,i) => {
    let testb = sys.peek(infilePtr + i) & 255 // for some reason this must be located here
    if (testb != b) {
        magicMatching = false
    }
})
if (!magicMatching) {
    println("Not an iPF file (MAGIC mismatch)")
    return 1
}

// decode input image
let ipfFile = files.open("$:/FBIPF")
graphics.clearText(); graphics.clearPixels(0); graphics.clearPixels2(0)
ipfFile.pwrite(infilePtr, infile.size, 0)
sys.free(infilePtr)

/*let width = sys.peek(infilePtr+8) | (sys.peek(infilePtr+9) << 8)
let height = sys.peek(infilePtr+10) | (sys.peek(infilePtr+11) << 8)
let hasAlpha = (sys.peek(infilePtr+12) != 0)
let ipfType = sys.peek(infilePtr+13)
let imgLen = sys.peek(infilePtr+24) | (sys.peek(infilePtr+25) << 8) | (sys.peek(infilePtr+26) << 16) | (sys.peek(infilePtr+27) << 24)
let decodefun = undefined
if (ipfType == 1) decodefun = graphics.decodeIpf1
if (ipfType == 2) decodefun = graphics.decodeIpf2
if (decodefun === undefined) throw Error(`Unknown IPF format: ${ipfType}`)

let ipfbuf = sys.malloc(imgLen)
gzip.decompFromTo(infilePtr + 28, infile.size - 28, ipfbuf) // should return FBUF_SIZE
sys.free(infilePtr)

graphics.setGraphicsMode(4)
graphics.clearText(); graphics.clearPixels(0); graphics.clearPixels2(0)
decodefun(ipfbuf, -1048577, -1310721, width, height, hasAlpha)

sys.free(ipfbuf)*/


let wait = interactive

if (interactive) {
    con.clear(); con.curs_set(0); con.move(1,1)
    println("Push and hold Backspace to exit")
}

let t1 = sys.nanoTime()
let akku = 0
let notifHideTimer = 0
const NOTIF_SHOWUPTIME = 3000000000
while (wait) {
    sys.poke(-40, 1)
    if (sys.peek(-41) == 67) {
        wait = false
        con.curs_set(1)
    }

    sys.sleep(50)

    let t2 = sys.nanoTime()
    akku += (t2 - t1) / 1000000000.0

    notifHideTimer += (t2 - t1)
    if (notifHideTimer > NOTIF_SHOWUPTIME) {
        con.clear()
    }

    t1 = t2

}