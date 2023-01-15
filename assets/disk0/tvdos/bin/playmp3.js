const Mp3 = require('mp3dec')
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

    /*readFull(n) {
        throw Error()
        let ptr = this.seq.readBytes(n)
        return ptr
    }*/

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

    readByteNumbers(n) {
        let ptr = this.seq.readBytes(n)
        try {
            let s = []
            for (let i = 0; i < n; i++) {
                if (i >= this.length) break
                s.push(sys.peek(ptr + i))
            }
            sys.free(ptr)
            return s
        }
        catch (e) {
            println(`n: ${n}; ptr: ${ptr}`)
            println(e)
        }
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

    /*get remaining() {
        return this.length - this.getReadCount()
    }*/
}



con.curs_set(0)
let [cy, cx] = con.getyx()
let [__, CONSOLE_WIDTH] = con.getmaxyx()
let paintWidth = CONSOLE_WIDTH - 16
if (interactive) {
    println("Decoding...")
}


printdbg("pre-decode...")
let filebuf = new SequentialFileBuffer(_G.shell.resolvePathInput(exec_args[1]).full)
const FILE_SIZE = filebuf.length
let decoder = Mp3.newDecoder(filebuf)
if (decoder === null) throw Error("decoder is null")

const HEADER_SIZE = decoder.headerSize + 3
const FRAME_SIZE = decoder.frameSize // only works reliably for CBR

//serial.println(`header size: ${HEADER_SIZE}`)
//serial.println(`frame size: ${FRAME_SIZE}`)

audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setPcmQueueCapacityIndex(0, 5) // queue size is now 24
const QUEUE_MAX = audio.getPcmQueueCapacity(0)
audio.setMasterVolume(0, 255)
audio.play(0)

let decodedLength = 0
let readPtr = sys.malloc(8000)
let decodePtr = sys.malloc(12000)

function bytesToSec(i) {
    // using fixed value: FRAME_SIZE(216) bytes for 36 ms on sampling rate 32000 Hz
    return i / (FRAME_SIZE * 1000 / bufRealTimeLen)
}
function secToReadable(n) {
    let mins = ''+((n/60)|0)
    let secs = ''+(n % 60)
    return `${mins.padStart(2,'0')}:${secs.padStart(2,'0')}`
}
function decodeAndResample(inPtr, outPtr, inputLen) {
    // TODO resample
    for (let k = 0; k < inputLen / 2; k+=2) {
        let sample = [
            pcm.u16Tos16(sys.peek(inPtr + k*2 + 0) | (sys.peek(inPtr + k*2 + 1) << 8)),
            pcm.u16Tos16(sys.peek(inPtr + k*2 + 2) | (sys.peek(inPtr + k*2 + 3) << 8))
        ]
        sys.poke(outPtr + k, pcm.s16Tou8(sample[0]))
        sys.poke(outPtr + k + 1, pcm.s16Tou8(sample[1]))
        // soothing visualiser(????)
//        printvis(`${sampleToVisual(sample[0])} | ${sampleToVisual(sample[1])}`)
    }
}


function printPlayBar() {
}

let stopPlay = false
con.curs_set(0)
if (interactive) {
    con.move(cy, cy)
    println("Push and hold Backspace to exit")
}
[cy, cx] = con.getyx()
function printPlayBar(currently) {
    if (interactive) {
//        let currently = decodedLength
        let total = FILE_SIZE - HEADER_SIZE

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
let t1 = sys.nanoTime()
let errorlevel = 0
let bufRealTimeLen = 36
try {
    decoder.decode((ptr, len, pos)=>{

        if (interactive) {
            sys.poke(-40, 1)
            if (sys.peek(-41) == 67) {
                stopPlay = true
                throw "STOP"
            }
        }

        printPlayBar(pos)

        let t2 = sys.nanoTime()

        decodedLength += len

//        serial.println(`Audio queue size: ${audio.getPosition(0)}/${QUEUE_MAX}`)

        if (audio.getPosition(0) >= QUEUE_MAX) {
            while (audio.getPosition(0) >= (QUEUE_MAX >>> 1)) {
                printdbg(`Queue full, waiting until the queue has some space (${audio.getPosition(0)}/${QUEUE_MAX})`)
//                serial.println(`Queue full, waiting until the queue has some space (${audio.getPosition(0)}/${QUEUE_MAX})`)
                sys.sleep(bufRealTimeLen)
            }
        }



        decodeAndResample(ptr, decodePtr, len)

        audio.putPcmDataByPtr(decodePtr, len >> 1, 0)
        audio.setSampleUploadLength(0, len >> 1)
        audio.startSampleUpload(0)


        let decodingTime = (t2 - t1) / 1000000.0
        bufRealTimeLen = (len >> 1) / 64000.0 * 1000
        t1 = t2

        printdbg(`Decoded ${decodedLength} bytes; target: ${bufRealTimeLen} ms, lag: ${decodingTime - bufRealTimeLen} ms`)


    }) // now you got decoded PCM data
}
catch (e) {
    if (e != "STOP") {
        printerrln(e)
        errorlevel = 1
    }
}
finally {
    //audio.stop(0)
    sys.free(readPtr)
    sys.free(decodePtr)
}

return errorlevel