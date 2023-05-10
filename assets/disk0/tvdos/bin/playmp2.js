const SND_BASE_ADDR = audio.getBaseAddr()

if (!SND_BASE_ADDR) return 10

const MP2_BITRATES = ["???", 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
const MP2_CHANNELMODES = ["Stereo", "Joint", "Dual", "Mono"]
const pcm = require("pcm")
const interactive = exec_args[2] && exec_args[2].toLowerCase() == "-i"
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
const FRAME_SIZE = audio.mp2GetInitialFrameSize(filebuf.fileHeader)
const MEDIA_BITRATE = MP2_BITRATES[filebuf.fileHeader[2] >>> 4]
const MEDIA_CHANNEL_MODE = MP2_CHANNELMODES[filebuf.fileHeader[3] >>> 6]


let bytes_left = FILE_SIZE
let decodedLength = 0


//serial.println(`Frame size: ${FRAME_SIZE}`)


con.curs_set(0)
let [__, CONSOLE_WIDTH] = con.getmaxyx()
if (interactive) {
    let [cy, cx] = con.getyx()
    // file name
    con.mvaddch(cy, 1)
    con.prnch(0xC9);con.prnch(0xCD);con.prnch(0xB5)
    print(filebuf.file.name)
    con.prnch(0xC6);con.prnch(0xCD)
    print("\x84205u".repeat(CONSOLE_WIDTH - 26 - filebuf.file.name.length))
    con.prnch(0xB5)
    print("Hold Bksp to Exit")
    con.prnch(0xC6);con.prnch(0xCD);con.prnch(0xBB)

    // L R pillar
    con.prnch(0xBA)
    con.mvaddch(cy+1, CONSOLE_WIDTH, 0xBA)

    // media info
    let mediaInfoStr = `MP2 ${MEDIA_CHANNEL_MODE} ${MEDIA_BITRATE}kbps`
    con.move(cy+2,1)
    con.prnch(0xC8)
    print("\x84205u".repeat(CONSOLE_WIDTH - 5 - mediaInfoStr.length))
    con.prnch(0xB5)
    print(mediaInfoStr)
    con.prnch(0xC6);con.prnch(0xCD);con.prnch(0xBC)

    con.move(cy+1, 2)
}
let [cy, cx] = con.getyx()
let paintWidth = CONSOLE_WIDTH - 20
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

        con.move(cy, 3)
        print(' '.repeat(15))
        con.move(cy, 3)

        print(`${secToReadable(currentlySec)} / ${secToReadable(totalSec)}`)

        con.move(cy, 17)
        print(' ')
        let progressbar = '\x84196u'.repeat(paintWidth + 1)
        print(progressbar)

        con.mvaddch(cy, 18 + Math.round(paintWidth * (currently / total)), 0xDB)
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

        if (audio.getPosition(0) >= QUEUE_MAX) {
            while (audio.getPosition(0) >= (QUEUE_MAX >>> 1)) {
                printdbg(`Queue full, waiting until the queue has some space (${audio.getPosition(0)}/${QUEUE_MAX})`)
                sys.sleep(bufRealTimeLen)
            }
        }
        audio.mp2UploadDecoded(0)
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