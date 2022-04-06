filesystem.open("A", exec_args[1], "R")

let status = com.getStatusCode(0)
let infile = undefined
if (0 != status) return status


let fileLen = filesystem.getFileLen("A")
println(`DMA reading ${fileLen} bytes from disk...`)
infile = sys.malloc(fileLen)
dma.comToRam(0, 0, infile, fileLen)


println("decoding")

// decode
const [imgw, imgh, imageData] = graphics.decodeImageResample(infile, fileLen, 560, 448)

println(`dim: ${imgw}x${imgh}`)
println(`converting to displayable format...`)

// convert colour
graphics.imageToDisplayableFormat(imageData, -1048577, imgw, imgh, 4, true)

sys.free(imageData)
sys.free(infile)
