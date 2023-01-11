// usage: playmov moviefile.mov [/i]
const interactive = exec_args[2].toLowerCase() == "/i"
const WIDTH = 560
const HEIGHT = 448
const FBUF_SIZE = WIDTH * HEIGHT
const AUTO_BGCOLOUR_CHANGE = true
const MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x4D, 0x4F, 0x56]


const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
const FILE_LENGTH = files.open(fullFilePath.full).size

con.clear();con.curs_set(0)


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


let width = seqread.readShort()
let height = seqread.readShort()
let fps = seqread.readShort(); if (fps == 0) fps = 9999

//fps = 9999

let frameTime = 1.0 / fps
let frameCount = seqread.readInt() % 16777216
let globalType = seqread.readShort()
sys.free(seqread.readBytes(12)) // skip 12 bytes
let akku = frameTime
let framesRendered = 0
//serial.println(seqread.getReadCount()) // must say 18
//serial.println(`Dim: (${width}x${height}), FPS: ${fps}, Frames: ${frameCount}`)

/*if (type != 4 && type != 5 && type != 260 && type != 261) {
    printerrln("Not an iPF mov")
    return 1
}*/
if (globalType != 255) {
    printerrln(`Unsupported MOV type (${globalType})`)
    return 1
}


let ipfbuf = sys.malloc(FBUF_SIZE)
graphics.setGraphicsMode(4)

let startTime = sys.nanoTime()
let framesRead = 0
let audioFired = false

audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setMasterVolume(0, 255)

function getRGBfromScr(x, y) {
    let offset = y * WIDTH + x
    let rg = sys.peek(-1048577 - offset)
    let ba = sys.peek(-1310721 - offset)

    return [(rg >>> 4) / 15.0, (rg & 15) / 15.0, (ba >>> 4) / 15.0]
}

let oldBgcol = [0.0, 0.0, 0.0]
let stopPlay = false
if (interactive) {
    con.move(1,1)
    println("Push and hold Backspace to exit")
}
let notifHideTimer = 0
const NOTIF_SHOWUPTIME = 2000000000
let [cy, cx] = con.getyx()
let t1 = sys.nanoTime()
renderLoop:
while (!stopPlay && seqread.getReadCount() < FILE_LENGTH) {

    if (akku >= frameTime) {

        let frameUnit = 0 // 0: no decode, 1: normal playback, 2+: skip (n-1) frames
        while (!stopPlay && akku >= frameTime) {
            if (interactive) {
                sys.poke(-40, 1)
                if (sys.peek(-41) == 67) {
                    stopPlay = true
                }
            }

            akku -= frameTime
            frameUnit += 1
        }

        if (frameUnit != 0) {
            // skip frames if necessary
            while (!stopPlay && frameUnit >= 1 && seqread.getReadCount() < FILE_LENGTH) {
                if (interactive) {
                    sys.poke(-40, 1)
                    if (sys.peek(-41) == 67) {
                        stopPlay = true
                    }
                }


                let packetType = seqread.readShort()

                // ideally, first two packets will be audio packets

                // sync packets
                if (65535 == packetType) {
                    frameUnit -= 1
                }
                // background colour packets
                else if (65279 == packetType) {
                    AUTO_BGCOLOUR_CHANGE = false
                    let rgbx = seqread.readInt()
                    graphics.setBackground(
                        (rgbx & 0xFF000000) >>> 24,
                        (rgbx & 0x00FF0000) >>> 16,
                        (rgbx & 0x0000FF00) >>> 8
                    )
                }
                // video packets
                else if (packetType < 2047) {
                    // iPF
                    if (packetType == 4 || packetType == 5 || packetType == 260 || packetType == 261) {
                        let decodefun = (packetType > 255) ? graphics.decodeIpf2 : graphics.decodeIpf1
                        let payloadLen = seqread.readInt()

                        if (framesRead >= frameCount) {
                            break renderLoop
                        }

                        framesRead += 1
                        let gzippedPtr = seqread.readBytes(payloadLen)
                        framesRendered += 1

                        if (frameUnit == 1) {
                            gzip.decompFromTo(gzippedPtr, payloadLen, ipfbuf) // should return FBUF_SIZE
                            decodefun(ipfbuf, -1048577, -1310721, width, height, (packetType & 255) == 5)


                            // calculate bgcolour from the edges of the screen
                            if (AUTO_BGCOLOUR_CHANGE) {
                                let samples = []
                                for (let x = 8; x < 560; x+=32) {
                                    samples.push(getRGBfromScr(x, 3))
                                    samples.push(getRGBfromScr(x, 445))
                                }
                                for (let y = 29; y < 448; y+=26) {
                                    samples.push(getRGBfromScr(8, y))
                                    samples.push(getRGBfromScr(552, y))
                                }

                                let out = [0.0, 0.0, 0.0]
                                samples.forEach(rgb=>{
                                    out[0] += rgb[0]
                                    out[1] += rgb[1]
                                    out[2] += rgb[2]
                                })
                                out[0] = out[0] / samples.length / 2.0 // darken a bit
                                out[1] = out[1] / samples.length / 2.0
                                out[2] = out[2] / samples.length / 2.0

                                let bgr = (oldBgcol[0]*5 + out[0]) / 6.0
                                let bgg = (oldBgcol[1]*5 + out[1]) / 6.0
                                let bgb = (oldBgcol[2]*5 + out[2]) / 6.0

                                oldBgcol = [bgr, bgg, bgb]

                                graphics.setBackground(Math.round(bgr * 255), Math.round(bgg * 255), Math.round(bgb * 255))
                            }


                            // defer audio playback until a first frame is sent
                            if (!audioFired) {
                                audio.play(0)
                                audioFired = true
                            }
                        }

                        sys.free(gzippedPtr)
                    }
                    else {
                        throw Error(`Unknown Video Packet with type ${packetType} at offset ${seqread.getReadCount() - 2}`)
                    }
                }
                // audio packets
                else if (4096 <= packetType && packetType <= 6133) {
                    if (4097 == packetType) {
                        let readLength = seqread.readInt()
                        let samples = seqread.readBytes(readLength)

                        if (readLength == 0) throw Error("Readlength is zero")

                        audio.putPcmDataByPtr(samples, readLength, 0)
                        audio.setSampleUploadLength(0, readLength)
                        audio.startSampleUpload(0)

                        sys.free(samples)
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
        else {
            framesRendered += 1
        }

    }
    sys.sleep(1)

    let t2 = sys.nanoTime()
    akku += (t2 - t1) / 1000000000.0

    if (interactive) {
        notifHideTimer += (t2 - t1)
        if (notifHideTimer > NOTIF_SHOWUPTIME) {
            con.clear()
        }
    }

    t1 = t2
}
let endTime = sys.nanoTime()

sys.free(ipfbuf)
audio.stop(0)

let timeTook = (endTime - startTime) / 1000000000.0

//println(`Actual FPS: ${framesRendered / timeTook}`)