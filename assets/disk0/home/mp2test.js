exec_args[1] = "A:/loopey.mp2"

const mp2 = require('mp2dec')
const pcm = require("pcm")
const interactive = exec_args[2] && exec_args[2].toLowerCase() == "/i"

function printdbg(s) { if (1) serial.println(s) }

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

    /*readByteNumbers(n) {
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
    }*/

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


// this reads file, initialises all the craps, gets initial frame size, then discards everything; truly wasteful :)
function getInitialFrameSize() {

    let frame = filebuf.readBytes(4096)
    let mp2 = require('mp2dec')
    let mp2context = mp2.kjmp2_make_mp2_state()
    mp2.kjmp2_init(mp2context)

    let sampleRate = mp2.kjmp2_get_sample_rate(frame)
    let [frameSize, _] = mp2.kjmp2_decode_frame(mp2context, frame, null, [])

    filebuf.rewind()
    sys.free(frame)

    return [frameSize, sampleRate]
}




let filebuf = new SequentialFileBuffer(_G.shell.resolvePathInput(exec_args[1]).full)
const FILE_SIZE = filebuf.length - 100


const [FRAME_SIZE, SAMPLE_RATE] = getInitialFrameSize()
let bytes_left = FILE_SIZE
let decodedLength = 0


println(`Sampling rate: ${SAMPLE_RATE}, Frame size: ${FRAME_SIZE}`)



function decodeAndResample(inPtrL, inPtrR, outPtr, inputLen) {
    // TODO resample
    for (let k = 0; k < inputLen; k+=2) {
        let sample = [
            pcm.u16Tos16(sys.peek(inPtrL + k + 0) | (sys.peek(inPtrL + k + 1) << 8)),
            pcm.u16Tos16(sys.peek(inPtrR + k + 0) | (sys.peek(inPtrR + k + 1) << 8))
        ]
        sys.poke(outPtr + k, pcm.s16Tou8(sample[0]))
        sys.poke(outPtr + k + 1, pcm.s16Tou8(sample[1]))
    }
}
function decodeEvent(frameSize, len) {
    if (interactive) {
        sys.poke(-40, 1)
        if (sys.peek(-41) == 67) {
            stopPlay = true
            throw "STOP"
        }
    }

//    printPlayBar(pos)

    let t2 = sys.nanoTime()

    decodedLength += frameSize

    printdbg(`Audio queue size: ${audio.getPosition(0)}/${QUEUE_MAX}`)

    if (audio.getPosition(0) >= QUEUE_MAX) {
        while (audio.getPosition(0) >= (QUEUE_MAX >>> 1)) {
            printdbg(`Queue full, waiting until the queue has some space (${audio.getPosition(0)}/${QUEUE_MAX})`)
            sys.sleep(bufRealTimeLen)
        }
    }


    decodeAndResample(samplePtrL, samplePtrR, decodePtr, len)
    audio.putPcmDataByPtr(decodePtr, len, 0)
    audio.setSampleUploadLength(0, len)
    audio.startSampleUpload(0)


    let decodingTime = (t2 - t1) / 1000000.0
    bufRealTimeLen = (len) / 64000.0 * 1000
    t1 = t2

    println(`Decoded ${decodedLength} bytes; target: ${bufRealTimeLen} ms, lag: ${decodingTime - bufRealTimeLen} ms`)
}



audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setPcmQueueCapacityIndex(0, 5) // queue size is now 24
const QUEUE_MAX = audio.getPcmQueueCapacity(0)
audio.setMasterVolume(0, 255)
audio.play(0)


let mp2context = mp2.kjmp2_make_mp2_state()
mp2.kjmp2_init(mp2context)

// decode frame
let frame = sys.malloc(FRAME_SIZE)
let samplePtrL = sys.malloc(6000) // 16b samples
let samplePtrR = sys.malloc(6000) // 16b samples
let decodePtr = sys.malloc(6000) // 8b samples
let t1 = sys.nanoTime()
let bufRealTimeLen = 36
while (bytes_left >= 0) {

//    println(`Bytes left: ${bytes_left}`)


    filebuf.readBytes(FRAME_SIZE, frame)
    bytes_left -= FRAME_SIZE

    let decodedL = []
    let decodedR = []
    let pcm = []
    let [frameSize, samples] = mp2.kjmp2_decode_frame(mp2context, frame, pcm, samplePtrL, samplePtrR)
    if (frameSize) {
        // play using decodedLR
        decodeEvent(frameSize, samples)
    }

}

sys.free(frame)
sys.free(decodePtr)
sys.free(samplePtrL)
sys.free(samplePtrR)
