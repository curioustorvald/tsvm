const SND_BASE_ADDR = audio.getBaseAddr()

if (!SND_BASE_ADDR) return 10

const pcm = require("pcm")
const interactive = exec_args[2] && exec_args[2].toLowerCase() == "/i"
function printdbg(s) { if (0) serial.println(s) }


class SequentialFileBuffer {

    constructor(path, offset, length) {
        if (Array.isArray(path)) throw Error("arg #1 is path(string), not array")

        this.path = path
        this.file = files.open(path)

        this.offset = offset || 0
        this.originalOffset = offset
        this.length = length || this.file.size

        this.seq = require("seqread")
        this.seq.prepare(path)
    }

    readBytes(size, ptr) {
        return this.seq.readBytes(size, ptr)
    }

    readStr(n) {
        let ptr = this.seq.readBytes(n)
        let s = ''
        for (let i = 0; i < n; i++) {
            if (i >= this.length) break
            s += String.fromCharCode(sys.peek(ptr + i))
        }
        sys.free(ptr)
        return s
    }

    unread(diff) {
        let newSkipLen = this.seq.getReadCount() - diff
        this.seq.prepare(this.path)
        this.seq.skip(newSkipLen)
    }

    rewind() {
        this.seq.prepare(this.path)
    }

    seek(p) {
        this.seq.prepare(this.path)
        this.seq.skip(p)
    }

    get byteLength() {
        return this.length
    }

    get fileHeader() {
        return this.seq.fileHeader
    }

    /*get remaining() {
        return this.length - this.getReadCount()
    }*/
}





let filebuf = new SequentialFileBuffer(_G.shell.resolvePathInput(exec_args[1]).full)
const FILE_SIZE = filebuf.length// - 100
let FRAME_SIZE = audio.mp2GetInitialFrameSize(filebuf.fileHeader)


let bytes_left = FILE_SIZE
let decodedLength = 0


serial.println(`Frame size: ${FRAME_SIZE}`)



function decodeAndResample(inPtrL, inPtrR, outPtr, inputLen) {
    // TODO resample
    for (let k = 0; k < inputLen; k+=2) {
        let sample1 = pcm.u16Tos16(sys.peek(inPtrL + k + 0) | (sys.peek(inPtrL + k + 1) << 8))
        let sample2 = pcm.u16Tos16(sys.peek(inPtrR + k + 0) | (sys.peek(inPtrR + k + 1) << 8))
        sys.poke(outPtr + k, pcm.s16Tou8(sample1))
        sys.poke(outPtr + k + 1, pcm.s16Tou8(sample2))
    }
}
function decodeEvent(frameSize, len) {

    let t2 = sys.nanoTime()

//    printdbg(`Audio queue size: ${audio.getPosition(0)}/${QUEUE_MAX}`)

    if (audio.getPosition(0) >= QUEUE_MAX) {
        while (audio.getPosition(0) >= (QUEUE_MAX >>> 1)) {
            printdbg(`Queue full, waiting until the queue has some space (${audio.getPosition(0)}/${QUEUE_MAX})`)
            sys.sleep(bufRealTimeLen)
        }
    }


//    decodeAndResample(samplePtrL, samplePtrR, decodePtr, len)

    audio.putPcmDataByPtr(decodePtr, len, 0)
    audio.setSampleUploadLength(0, len)
    audio.startSampleUpload(0)

    sys.sleep(10)

    let decodingTime = (t2 - t1) / 1000000.0
    bufRealTimeLen = (len) / 64000.0 * 1000
    t1 = t2

//    println(`Decoded ${decodedLength} bytes; target: ${bufRealTimeLen} ms, lag: ${decodingTime - bufRealTimeLen} ms`)
}


con.curs_set(0)
con.curs_set(0)
if (interactive) {
    println("Push and hold Backspace to exit")
}
let [cy, cx] = con.getyx()
let [__, CONSOLE_WIDTH] = con.getmaxyx()
let paintWidth = CONSOLE_WIDTH - 16
function bytesToSec(i) {
    // using fixed value: FRAME_SIZE(216) bytes for 36 ms on sampling rate 32000 Hz
    return i / (FRAME_SIZE * 1000 / bufRealTimeLen)
}
function secToReadable(n) {
    let mins = ''+((n/60)|0)
    let secs = ''+(n % 60)
    return `${mins.padStart(2,'0')}:${secs.padStart(2,'0')}`
}
function printPlayBar(currently) {
    if (interactive) {
        let currently = decodedLength
        let total = FILE_SIZE

        let currentlySec = Math.round(bytesToSec(currently))
        let totalSec = Math.round(bytesToSec(total))

        con.move(cy, 1)
        print(' '.repeat(15))
        con.move(cy, 1)

        print(`${secToReadable(currentlySec)} / ${secToReadable(totalSec)}`)

        con.move(cy, 15)
        print(' ')
        let progressbar = '\x84205u'.repeat(paintWidth + 1)
        print(progressbar)

        con.mvaddch(cy, 16 + Math.round(paintWidth * (currently / total)), 0xDB)
    }
}



audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setPcmQueueCapacityIndex(0, 2) // queue size is now 8
const QUEUE_MAX = audio.getPcmQueueCapacity(0)
audio.setMasterVolume(0, 255)
audio.play(0)


//let mp2context = audio.mp2Init()
audio.mp2Init()

// decode frame
let t1 = sys.nanoTime()
let bufRealTimeLen = 36
let stopPlay = false
let errorlevel = 0
try {
    while (bytes_left > 0 && !stopPlay) {

        if (interactive) {
            sys.poke(-40, 1)
            if (sys.peek(-41) == 67) {
                stopPlay = true
            }
        }

        printPlayBar()


        filebuf.readBytes(FRAME_SIZE, SND_BASE_ADDR - 2368)
        audio.mp2Decode()
        sys.waitForMemChg(SND_BASE_ADDR - 41, 255, 255)

        if (audio.getPosition(0) >= QUEUE_MAX) {
            while (audio.getPosition(0) >= (QUEUE_MAX >>> 1)) {
                printdbg(`Queue full, waiting until the queue has some space (${audio.getPosition(0)}/${QUEUE_MAX})`)
                sys.sleep(bufRealTimeLen)
            }
        }
        audio.putPcmDataByPtr(SND_BASE_ADDR - 64, 2304, 0)
        audio.setSampleUploadLength(0, 2304)
        audio.startSampleUpload(0)
        sys.sleep(10)



        bytes_left -= FRAME_SIZE
        decodedLength += FRAME_SIZE
    }
}
catch (e) {
    printerrln(e)
    errorlevel = 1
}
finally {
}

return errorlevel