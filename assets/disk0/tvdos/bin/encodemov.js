// some manual configurations
//
let IPFMODE = 2 // 1 or 2
let TOTAL_FRAMES = 3813
let FPS = 30
let WIDTH = 560
let HEIGHT = 448
let PATHFUN = (i) => `/ddol2/${(''+i).padStart(5,'0')}.bmp` // how can be the image file found, if a frame number (starts from 1) were given
let AUDIOTRACK = 'ddol.pcm'
// to export video to its frames:
//     ffmpeg -i file.mp4 file/%05d.bmp
// the input frames must be resized (and cropped) beforehand, using ImageMagick is recommended, like so:
//     mogrify -path ./path/to/write/results/ -resize 560x448^ -gravity Center -extent 560x448 ./path/to/source/files/*
//
// end of manual configuration

let outfilename = exec_args[1]
if (!outfilename) {
    println("Usage: encodemov <outfile>")
    return 1
}

const FBUF_SIZE = WIDTH * HEIGHT
let infile = sys.malloc(512000) // somewhat arbitrary
let imagearea = sys.malloc(FBUF_SIZE*3)
let decodearea = sys.malloc(FBUF_SIZE)
let ipfarea = sys.malloc(FBUF_SIZE)
let gzippedImage = sys.malloc(512000) // somewhat arbitrary


let outfile = files.open(_G.shell.resolvePathInput(outfilename).full)


function appendToOutfile(bytes) {
    outfile.bappend(bytes)
}

function appendToOutfilePtr(ptr, len) {
    outfile.pappend(ptr, len)
}

const packetType = [
    4, (IPFMODE - 1)
]
const syncPacket = [255, 255]

// write header to the file
let headerBytes = [
    0x1F, 0x54, 0x53, 0x56, 0x4D, 0x4D, 0x4F, 0x56, // magic
    WIDTH & 255, (WIDTH >> 8) & 255, // width
    HEIGHT & 255, (HEIGHT >> 8) & 255, // height
    FPS & 255, (FPS >> 8) & 255, // FPS
    TOTAL_FRAMES & 255, (TOTAL_FRAMES >> 8) & 255, (TOTAL_FRAMES >> 16) & 255, (TOTAL_FRAMES >> 24) & 255, // frame count
    0xFF, 0x00, // new standard deprecates global type
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // reserved
]

let ipfFun = (IPFMODE == 1) ? graphics.encodeIpf1 : (IPFMODE == 2) ? graphics.encodeIpf2 : 0
if (!ipfFun) throw Error("Unknown IPF mode "+IPFMODE)



const AUDIO_SAMPLE_SIZE = 2 * ((30000 / FPS) + 1)|0 // times 2 because stereo
let audioBytesRead = 0
const audioFile = (AUDIOTRACK) ? files.open(_G.shell.resolvePathInput(AUDIOTRACK).full) : undefined
let audioRemaining = (audioFile) ? audioFile.size : 0
const audioPacket = [1, 16]


outfile.bwrite(headerBytes)

for (let f = 1; ; f++) {

    // insert sync packet
    if (f > 1) appendToOutfile(syncPacket)

    // insert audio track, if any
    if (audioRemaining > 0) {

        // first frame gets two audio packets
        for (let repeat = 0; repeat < ((f == 1) ? 2 : 1); repeat++) {

    //        print(`Frame ${f}/${TOTAL_FRAMES} (ADPCM) ->`)
            print(`Frame ${f}/${TOTAL_FRAMES} (PCMu8) ->`)

            const actualBytesToRead = Math.min(
                (f % 2 == 1) ? AUDIO_SAMPLE_SIZE : AUDIO_SAMPLE_SIZE + 2,
                audioRemaining
            )
            audioFile.pread(infile, actualBytesToRead, audioBytesRead)

            let pcmSize = [
                (actualBytesToRead >>> 0) & 255,
                (actualBytesToRead >>> 8) & 255,
                (actualBytesToRead >>> 16) & 255,
                (actualBytesToRead >>> 24) & 255
            ]

            appendToOutfile(audioPacket)
            appendToOutfile(pcmSize)
            appendToOutfilePtr(infile, actualBytesToRead)

            print(` ${actualBytesToRead} bytes\n`)

            audioBytesRead += actualBytesToRead
            audioRemaining -= actualBytesToRead
        }
    }
    // insert video frame
    if (f <= TOTAL_FRAMES) {
        let fname = PATHFUN(f)
        let framefile = files.open(_G.shell.resolvePathInput(fname).full)
        let fileLen = framefile.size
        framefile.pread(infile, fileLen)


        let [_1, _2, channels, _3] = graphics.decodeImageTo(infile, fileLen, imagearea)

        print(`Frame ${f}/${TOTAL_FRAMES} (Ch: ${channels}) ->`)

    //    graphics.imageToDisplayableFormat(imagearea, decodearea, 560, 448, 3, 1)
        ipfFun(imagearea, ipfarea, WIDTH, HEIGHT, channels, false, f)

        let gzlen = gzip.compFromTo(ipfarea, FBUF_SIZE, gzippedImage)

        let frameSize = [
            (gzlen >>> 0) & 255,
            (gzlen >>> 8) & 255,
            (gzlen >>> 16) & 255,
            (gzlen >>> 24) & 255
        ]

        appendToOutfile(packetType)
        appendToOutfile(frameSize)
        appendToOutfilePtr(gzippedImage, gzlen)

        print(` ${gzlen} bytes\n`)
    }

    // if there is no video and audio remaining, exit the loop
    if (f > TOTAL_FRAMES && audioRemaining <= 0) break
}

sys.free(infile)
sys.free(imagearea)
sys.free(decodearea)
sys.free(ipfarea)
sys.free(gzippedImage)