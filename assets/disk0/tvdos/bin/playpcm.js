// usage: playpcm audiofile.pcm [/i]
let fileeeee = files.open(_G.shell.resolvePathInput(exec_args[1]).full)
let filename = fileeeee.fullPath
function printdbg(s) { if (0) serial.println(s) }

const interactive = exec_args[2] && exec_args[2].toLowerCase() == "-i"
const pcm = require("pcm")
const FILE_SIZE = files.open(filename).size



function printComments() {
    for (const [key, value] of Object.entries(comments)) {
        printdbg(`${key}: ${value}`)
    }
}

function GCD(a, b) {
    a = Math.abs(a)
    b = Math.abs(b)
    if (b > a) {var temp = a; a = b; b = temp}
    while (true) {
        if (b == 0) return a
        a %= b
        if (a == 0) return b
        b %= a
    }
}

function LCM(a, b) {
    return (!a || !b) ? 0 : Math.abs((a * b) / GCD(a, b))
}



//println("Reading...")
//serial.println("!!! READING")

const seqread = require("seqread")
seqread.prepare(filename)






let BLOCK_SIZE = 4096
let INFILE_BLOCK_SIZE = BLOCK_SIZE
const QUEUE_MAX = 8 // according to the spec

let nChannels = 2
let samplingRate = pcm.HW_SAMPLING_RATE;
let blockSize = 2;
let bitsPerSample = 8;
let byterate = 2*samplingRate;
let comments = {};
let readPtr = undefined
let decodePtr = undefined

function bytesToSec(i) {
    return i / byterate
}
function secToReadable(n) {
    let mins = ''+((n/60)|0)
    let secs = ''+(n % 60)
    return `${mins.padStart(2,'0')}:${secs.padStart(2,'0')}`
}

let stopPlay = false
con.curs_set(0)
let [__, CONSOLE_WIDTH] = con.getmaxyx()
if (interactive) {
    let [cy, cx] = con.getyx()
    // file name
    con.mvaddch(cy, 1)
    con.prnch(0xC9);con.prnch(0xCD);con.prnch(0xB5)
    print(fileeeee.name)
    con.prnch(0xC6);con.prnch(0xCD)
    print("\x84205u".repeat(CONSOLE_WIDTH - 26 - fileeeee.name.length))
    con.prnch(0xB5)
    print("Hold Bksp to Exit")
    con.prnch(0xC6);con.prnch(0xCD);con.prnch(0xBB)

    // L R pillar
    con.prnch(0xBA)
    con.mvaddch(cy+1, CONSOLE_WIDTH, 0xBA)

    // media info
    let mediaInfoStr = `Raw PCM 512kbps`
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
// read chunks loop
readPtr = sys.malloc(BLOCK_SIZE * bitsPerSample / 8)
decodePtr = sys.malloc(BLOCK_SIZE * pcm.HW_SAMPLING_RATE / samplingRate)


audio.resetParams(0)
audio.purgeQueue(0)
audio.setPcmMode(0)
audio.setMasterVolume(0, 255)

let readLength = 1

function printPlayBar() {
    if (interactive) {
        let currently = seqread.getReadCount()
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
let errorlevel = 0
try {
while (!stopPlay && seqread.getReadCount() < FILE_SIZE && readLength > 0) {
    if (interactive) {
        sys.poke(-40, 1)
        if (sys.peek(-41) == 67) {
            stopPlay = true
        }
    }


    let queueSize = audio.getPosition(0)
    if (queueSize <= 1) {

        printPlayBar()

        // upload four samples for lag-safely
        for (let repeat = QUEUE_MAX - queueSize; repeat > 0; repeat--) {
            let remainingBytes = FILE_SIZE - seqread.getReadCount()

            readLength = (remainingBytes < INFILE_BLOCK_SIZE) ? remainingBytes : INFILE_BLOCK_SIZE
            if (readLength <= 0) {
                printdbg(`readLength = ${readLength}`)
                break
            }

            printdbg(`offset: ${seqread.getReadCount()}/${FILE_SIZE}; readLength: ${readLength}`)

            seqread.readBytes(readLength, readPtr)

            audio.putPcmDataByPtr(readPtr, readLength, 0)
            audio.setSampleUploadLength(0, readLength)
            audio.startSampleUpload(0)


            if (repeat > 1) sys.sleep(10)

            printPlayBar()
        }

        audio.play(0)
    }

    let remainingBytes = FILE_SIZE - seqread.getReadCount()
    printdbg(`readLength = ${readLength}; remainingBytes2 = ${remainingBytes}; seqread.getReadCount() = ${seqread.getReadCount()};`)


    sys.sleep(10)
}
}
catch (e) {
    printerrln(e)
    errorlevel = 1
}
finally {
    //audio.stop(0)
    if (readPtr !== undefined) sys.free(readPtr)
    if (decodePtr !== undefined) sys.free(decodePtr)
}

return errorlevel

