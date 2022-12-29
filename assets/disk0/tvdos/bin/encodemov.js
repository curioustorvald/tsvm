// some manual configurations
let IPFMODE = 2 // 1 or 2
let TOTAL_FRAMES = 901
let FPS = 30
let WIDTH = 560
let HEIGHT = 448
let PATHFUN = (i) => `/welcome104crop/${(''+i).padStart(5,'0')}.bmp` // how can be the image file found, if a frame number (starts from 1) were given
// to export video to its frames:
//     ffmpeg -i file.mp4 file/%05d.bmp
// the input frames must be resized (and cropped) beforehand, using ImageMagick is recommended, like so:
//     mogrify -path ./path/to/write/results/ -resize 560x448^ -gravity Center -extent 560x448 ./path/to/source/files/*

const FBUF_SIZE = WIDTH * HEIGHT
let infile = sys.malloc(512000) // somewhat arbitrary
let imagearea = sys.malloc(FBUF_SIZE*3)
let decodearea = sys.malloc(FBUF_SIZE)
let ipfarea = sys.malloc(FBUF_SIZE)
let gzippedImage = sys.malloc(512000) // somewhat arbitrary

let outfilename = exec_args[1]
if (!outfilename) {
    println("Usage: encodemov <outfile>")
    return 1
}

let outfile = files.open(_G.shell.resolvePathInput(outfilename).full)


const filesystem = {};

filesystem._toPorts = (driveLetter) => {
    if (driveLetter.toUpperCase === undefined) {
        throw Error("'"+driveLetter+"' (type: "+typeof driveLetter+") is not a valid drive letter");
    }
    var port = _TVDOS.DRIVES[driveLetter.toUpperCase()];
    if (port === undefined) {
        throw Error("Drive letter '" + driveLetter.toUpperCase() + "' does not exist");
    }
    return port
}
filesystem._close = (portNo) => {
    com.sendMessage(portNo, "CLOSE")
}
filesystem._flush = (portNo) => {
    com.sendMessage(portNo, "FLUSH")
}
filesystem.open = (driveLetter, path, operationMode) => {
    var port = filesystem._toPorts(driveLetter);

    filesystem._flush(port[0]); filesystem._close(port[0]);

    var mode = operationMode.toUpperCase();
    if (mode != "R" && mode != "W" && mode != "A") {
        throw Error("Unknown file opening mode: " + mode);
    }

    com.sendMessage(port[0], "OPEN"+mode+'"'+path+'",'+port[1]);
    return com.getStatusCode(port[0]);
}
filesystem.getFileLen = (driveLetter) => {
    var port = filesystem._toPorts(driveLetter);
    com.sendMessage(port[0], "GETLEN");
    var response = com.getStatusCode(port[0]);
    if (135 == response) {
        throw Error("File not opened");
    }
    if (response < 0 || response >= 128) {
        throw Error("Reading a file failed with "+response);
    }
    return Number(com.pullMessage(port[0]));
}
filesystem.write = (driveLetter, string) => {
    var port = filesystem._toPorts(driveLetter);
    com.sendMessage(port[0], "WRITE"+string.length);
    var response = com.getStatusCode(port[0]);
    if (135 == response) {
        throw Error("File not opened");
    }
    if (response < 0 || response >= 128) {
        throw Error("Writing a file failed with "+response);
    }
    com.sendMessage(port[0], string);
    filesystem._flush(port[0]); filesystem._close(port[0]);
}
filesystem.writeBytes = (driveLetter, bytes) => {
    var string = String.fromCharCode.apply(null, bytes); // no spreading: has length limit
    filesystem.write(driveLetter, string);
}



function appendToOutfile(bytes) {
    filesystem.open("A", outfilename, "A")
    filesystem.writeBytes("A", bytes)
}

function appendToOutfilePtr(ptr, len) {
    filesystem.open("A", outfilename, "A")
    dma.ramToCom(ptr, 0, len)
}

// write header to the file
let headerBytes = [
    0x1F, 0x54, 0x53, 0x56, 0x4D, 0x4D, 0x4F, 0x56, // magic
    WIDTH & 255, (WIDTH >> 8) & 255, // width
    HEIGHT & 255, (HEIGHT >> 8) & 255, // height
    FPS & 255, (FPS >> 8) & 255, // FPS
    TOTAL_FRAMES & 255, (TOTAL_FRAMES >> 8) & 255, (TOTAL_FRAMES >> 16) & 255, (TOTAL_FRAMES >> 24) & 255, // frame count
    0x04, IPFMODE - 1, // type 4 frames (force no-alpha)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // reserved
]

let ipfFun = (IPFMODE == 1) ? graphics.encodeIpf1 : (IPFMODE == 2) ? graphics.encodeIpf2 : 0
if (!ipfFun) throw Error("Unknown IPF mode "+IPFMODE)

filesystem.open("A", outfilename, "W")
filesystem.writeBytes("A", headerBytes)

for (let f = 1; f <= TOTAL_FRAMES; f++) {
    let fname = PATHFUN(f)
    filesystem.open("A", fname, "R")
    let fileLen = filesystem.getFileLen("A")
    dma.comToRam(0, 0, infile, fileLen)


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

    appendToOutfile(frameSize)
    appendToOutfilePtr(gzippedImage, gzlen)

    print(` ${gzlen} bytes\n`)
}

sys.free(infile)
sys.free(imagearea)
sys.free(decodearea)
sys.free(ipfarea)
sys.free(gzippedImage)