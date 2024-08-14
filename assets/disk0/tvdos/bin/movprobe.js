// usage: playmov moviefile.mov [/i]
const MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x4D, 0x4F, 0x56]
const pcm = require("pcm")
const MP2_FRAME_SIZE = [144,216,252,288,360,432,504,576,720,864,1008,1152,1440,1728]
const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
const FILE_LENGTH = files.open(fullFilePath.full).size

let seqread = require("seqread")
seqread.prepare(fullFilePath.full)



let magic = seqread.readBytes(8)
let magicMatching = true

// check if magic number matches
MAGIC.forEach((b,i) => {
    let testb = sys.peek(magic + i) & 255 // for some reason this must be located here
    if (testb != b) {
        magicMatching = false
    }
})
sys.free(magic)
if (!magicMatching) {
    println("Not a movie file (MAGIC mismatch)")
    return 1
}

let mp2Initialised = false

let width = seqread.readShort()
let height = seqread.readShort()
let fps = seqread.readShort(); if (fps == 0) fps = 9999

const FRAME_TIME = 1.0 / fps
const FRAME_COUNT = seqread.readInt() % 16777216
seqread.readShort() // skip unused field
const audioQueueInfo = seqread.readShort()
const AUDIO_QUEUE_LENGTH = (audioQueueInfo >> 12) + 1
const AUDIO_QUEUE_BYTES = (audioQueueInfo & 0xFFF) << 2
seqread.skip(10)

let stats = {
    "sync":0,
    "background":0,
    "ipf1":0,
    "ipf2":0,
    "ipf1a":0,
    "ipf2a":0,
    "ipf1_delta":0,
    "ipf2_delta":0,
    "audio_mp2":0,
    "audio_pcm":0
}


let errorlevel = 0
try {
renderLoop:
while (seqread.getReadCount() < FILE_LENGTH) {

    let packetType = seqread.readShort()

    // ideally, first two packets will be audio packets

    // sync packets
    if (65535 == packetType) {
        stats["sync"] += 1
    }
    // background colour packets
    else if (65279 == packetType) {
        seqread.skip(4)

        stats["background"] += 1
    }
    // video packets
    else if (packetType < 2047) {
        // iPF
        if (packetType == 4) {
            stats["ipf1"] += 1
        }
        else if (packetType == 5) {
            stats["ipf1a"] += 1
        }
        else if (packetType == 260) {
            stats["ipf2"] += 1
        }
        else if (packetType == 261) {
            stats["ipf2a"] += 1
        }
        else {
            throw Error(`Unknown Video Packet with type ${packetType} at offset ${seqread.getReadCount() - 2}`)
        }

        let payloadLen = seqread.readInt()
        seqread.skip(payloadLen)
    }
    // audio packets
    else if (4096 <= packetType && packetType <= 6143) {
        let readLength = (packetType >>> 8 == 17) ?
            MP2_FRAME_SIZE[(packetType & 255) >>> 1] // if the packet is MP2, deduce it from the packet type
            : seqread.readInt() // else, read 4 more bytes
        if (readLength == 0) throw Error("Readlength is zero")

        // MP2
        if (packetType >>> 8 == 17) {
            stats["audio_mp2"] += 1
            seqread.skip(readLength)
        }
        // RAW PCM packets (decode on the fly)
        else if (packetType == 0x1000 || packetType == 0x1001) {
            stats["audio_pcm"] += 1
            seqread.skip(readLength)
        }
        else {
            throw Error(`Audio Packet with type ${packetType} at offset ${seqread.getReadCount() - 2}`)
        }
    }
    else {
        println(`Unknown Packet with type ${packetType} at offset ${seqread.getReadCount() - 2}`)
    }
}
}
catch (e) {
    printerrln(e)
    errorlevel = 1
}
finally {
    println("** Video Stats **")
    println(`Dimension: ${width}x${height}`)
    println(`Framerate: ${fps}`)
    println(`Syncs: ${stats["sync"]}`)
    println(`iPF1: ${stats["ipf1"]}`)
    println(`iPF2: ${stats["ipf2"]}`)
    println(`iPF1a: ${stats["ipf1a"]}`)
    println(`iPF2a: ${stats["ipf2a"]}`)
    println("** Audio Stats **")
    println(`MP2: ${stats["audio_mp2"]}`)
    println(`PCM: ${stats["audio_pcm"]}`)
}

return errorlevel