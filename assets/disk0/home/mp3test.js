const Mp3 = require('mp3dec')
const pcm = require("pcm")


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
        let s = []
        for (let i = 0; i < n; i++) {
            if (i >= this.length) break
            s.push(sys.peek(ptr + i))
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

    /*get remaining() {
        return this.length - this.getReadCount()
    }*/
}



Object.keys(Mp3).forEach(e=>{
    print(`${e}\t`)
})
println()

println("reading...")
//let arr = files.open("A:/gateless.mp3").bread()
//let ab = new ArrayBuffer(arr.length)
//let abba = new Uint8Array(ab)
//arr.forEach((v,i)=>{ abba[i] = v })
//let mp3ArrayBuffer = new Uint8Array(ab, 0, arr.length)*

println("decoding...")
let decoder = Mp3.newDecoder(new SequentialFileBuffer("A:/gateless0.mp3"))
if (decoder === null) throw Error("decoder is null")

audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setMasterVolume(0, 255)
audio.play(0)

let decodedLength = 0
let readPtr = sys.malloc(8000)
let decodePtr = sys.malloc(12000)


function decodeAndResample(readArr, decodePtr, readLength) {
    for (let i = 0; i < readLength; i+= 2) {
        let sample = pcm.u16Tos16(readArr[i] | (readArr[i+1] << 8))
        let u8 = pcm.s16Tou8(sample)

        sys.poke(decodePtr + (i >> 1), u8)
    }
    return readLength / 2
}


function printPlayBar() {
}


const QUEUE_MAX = 4
let t1 = sys.nanoTime()
decoder.decode(obj=>{
    let t2 = sys.nanoTime()


    let buf = obj.buf
    let err = obj.err

    decodedLength += buf.byteLength

    let declen = decodeAndResample(buf, decodePtr, buf.byteLength)

    audio.putPcmDataByPtr(decodePtr, declen, 0)
    audio.setSampleUploadLength(0, declen)
    audio.startSampleUpload(0)
    audio.play(0)


//    sys.sleep(10) // decoding time is slower than realtime :(


    let decodingTime = t2 - t1
    let bufRealTimeLen = (declen) / 64000.0 * 1000000000
    t1 = t2
    println(`Decoded ${decodedLength} bytes; lag: ${(decodingTime - bufRealTimeLen) / 1000000} ms`)




}) // now you got decoded PCM data

sys.free(readPtr)
sys.free(decodePtr)