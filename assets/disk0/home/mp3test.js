const Mp3 = require('mp3dec')
const pcm = require("pcm")


Object.keys(Mp3).forEach(e=>{
    print(`${e}\t`)
})
println()

println("reading...")
let arr = files.open("A:/gateless.mp3").bread()
let ab = new ArrayBuffer(arr.length)
let abba = new Uint8Array(ab)
arr.forEach((v,i)=>{ abba[i] = v })


let mp3ArrayBuffer = new Uint8Array(ab, 0, arr.length)

println("decoding...")
let decoder = Mp3.newDecoder(ab)
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
decoder.decode(obj=>{
    let buf = obj.buf
    let err = obj.err

    decodedLength += buf.byteLength

    let declen = decodeAndResample(buf, decodePtr, buf.byteLength)

    audio.putPcmDataByPtr(decodePtr, declen, 0)
    audio.setSampleUploadLength(0, declen)
    audio.startSampleUpload(0)
    audio.play(0)

    serial.println(`Send sample (${audio.getPosition(0)})`)
//    sys.sleep(0) // decoding time is slower than realtime :(


}) // now you got decoded PCM data

sys.free(readPtr)
sys.free(decodePtr)