// TSVM Universal Cue Format (UCF) Player
// Created by CuriousTorvald and Claude on 2025-09-22
// Usage: playucf cuefile.ucf [options]
// Options: -i (interactive mode)

if (!exec_args[1]) {
    serial.println("Usage: playucf cuefile.ucf [options]")
    serial.println("Options: -i (interactive mode)")
    return 1
}

const interactive = exec_args[2] && exec_args[2].toLowerCase() == "-i"
const fullFilePath = _G.shell.resolvePathInput(exec_args[1])

if (!files.open(fullFilePath.full).exists) {
    serial.println(`Error: File not found: ${fullFilePath.full}`)
    return 2
}

// UCF Format constants
const UCF_MAGIC = [0x1F, 0x54, 0x53, 0x56, 0x4D, 0x55, 0x43, 0x46] // "\x1FTSVM UCF"
const UCF_VERSION = 1
const ADDRESSING_EXTERNAL = 0x01
const ADDRESSING_INTERNAL = 0x02

// Media player mappings based on file extensions
const PLAYER_MAP = {
    'mp2': 'playmp2',
    'wav': 'playwav',
    'pcm': 'playpcm',
    'mv1': 'playmv1',
    'mv2': 'playtev',
    'mv3': 'playtav'
}

// Helper class for UCF file reading with internal addressing support
class UCFSequentialReader {
    constructor(path, baseOffset = 0) {
        this.path = path
        this.baseOffset = baseOffset
        this.currentOffset = 0

        // Detect if this is a TAPE device path
        if (path.startsWith("$:/TAPE") || path.startsWith("$:\\TAPE")) {
            this.seq = require("seqreadtape")
        } else {
            this.seq = require("seqread")
        }

        this.seq.prepare(path)

        // Skip to the base offset for internal addressing
        if (baseOffset > 0) {
            this.seq.skip(baseOffset)
            this.currentOffset = baseOffset
        }
    }

    readBytes(length) {
        this.currentOffset += length
        return this.seq.readBytes(length)
    }

    readOneByte() {
        this.currentOffset += 1
        return this.seq.readOneByte()
    }

    readShort() {
        this.currentOffset += 2
        return this.seq.readShort()
    }

    readString(length) {
        this.currentOffset += length
        return this.seq.readString(length)
    }

    skip(n) {
        this.currentOffset += n
        this.seq.skip(n)
    }

    // Skip to absolute position from base offset
    seekTo(position) {
        let targetOffset = this.baseOffset + position
        if (targetOffset < this.currentOffset) {
            // Need to rewind and seek forward
            this.seq.prepare(this.path)
            this.currentOffset = 0
            if (targetOffset > 0) {
                this.seq.skip(targetOffset)
                this.currentOffset = targetOffset
            }
        } else if (targetOffset > this.currentOffset) {
            // Skip forward
            let skipAmount = targetOffset - this.currentOffset
            this.seq.skip(skipAmount)
            this.currentOffset = targetOffset
        }
    }

    getPosition() {
        return this.currentOffset - this.baseOffset
    }
}

// Parse UCF file
serial.println(`Playing UCF: ${fullFilePath.full}`)

let reader = new UCFSequentialReader(fullFilePath.full)

// Read and validate magic
let magic = []
for (let i = 0; i < 8; i++) {
    magic.push(reader.readOneByte())
}

let magicValid = true
for (let i = 0; i < 8; i++) {
    if (magic[i] !== UCF_MAGIC[i]) {
        magicValid = false
        break
    }
}

if (!magicValid) {
    serial.println("Error: Invalid UCF magic signature")
    return 3
}

// Read header
let version = reader.readOneByte()
if (version !== UCF_VERSION) {
    serial.println(`Error: Unsupported UCF version: ${version} (expected ${UCF_VERSION})`)
    return 4
}

let numElements = reader.readShort()
// Skip reserved bytes (5 bytes)
reader.skip(5)

serial.println(`UCF Version: ${version}, Elements: ${numElements}`)

// Parse cue elements
let cueElements = []
for (let i = 0; i < numElements; i++) {
    let element = {}

    element.addressingModeAndIntent = reader.readOneByte()
    element.addressingMode = element.addressingModeAndIntent & 15
    let nameLength = reader.readShort()
    element.name = reader.readString(nameLength)

    if (element.addressingMode === ADDRESSING_EXTERNAL) {
        let pathLength = reader.readShort()
        element.path = reader.readString(pathLength)
        serial.println(`Element ${i + 1}: ${element.name} -> ${element.path} (external)`)
    } else if (element.addressingMode === ADDRESSING_INTERNAL) {
        // Read 48-bit offset (6 bytes, little endian)
        let offsetBytes = []
        for (let j = 0; j < 6; j++) {
            offsetBytes.push(reader.readOneByte())
        }

        element.offset = 0
        for (let j = 0; j < 6; j++) {
            element.offset |= (offsetBytes[j] << (j * 8))
        }

        serial.println(`Element ${i + 1}: ${element.name} -> offset ${element.offset} (internal)`)
    } else {
        serial.println(`Error: Unknown addressing mode: ${element.addressingMode}`)
        return 5
    }

    cueElements.push(element)
}

// Function to get file extension
function getFileExtension(filename) {
    let lastDot = filename.lastIndexOf('.')
    if (lastDot === -1) return ''
    return filename.substring(lastDot + 1).toLowerCase()
}

// Function to determine player for a file
function getPlayerForFile(filename) {
    let ext = getFileExtension(filename)
    return PLAYER_MAP[ext] || null
}

// Function to create a temporary file for internal addressing
function createTempFileForInternal(element, ucfPath) {
    // Create a unique temporary filename
    let tempFilename = `$:\\TMP\\temp_ucf_${Date.now()}_${element.name.replace(/[^a-zA-Z0-9]/g, '_')}`

    // For internal addressing, we abuse seqread by creating a "virtual" file view
    // We'll return a special path that our modified exec environment can handle
    return {
        isTemporary: true,
        path: tempFilename,
        ucfPath: ucfPath,
        offset: element.offset,
        name: element.name
    }
}

// Play each cue element in sequence
for (let i = 0; i < cueElements.length; i++) {
    let element = cueElements[i]

    serial.println(`\nPlaying element ${i + 1}/${numElements}: ${element.name}`)

    if (interactive && i > 0) {
        serial.print("Press ENTER to continue, 'q' to quit: ")
        let input = serial.readLine()
        if (input && input.toLowerCase().startsWith('q')) {
            serial.println("Playback stopped by user")
            break
        }
    }

    let playerFile = null
    let targetPath = null

    if (element.addressingMode === ADDRESSING_EXTERNAL) {
        // External addressing - resolve relative path
        let elementPath = element.path
        if (!elementPath.startsWith('A:\\') && !elementPath.startsWith('A:/')) {
            // Relative path - resolve relative to UCF file location
            let ucfDir = fullFilePath.full.substring(0, fullFilePath.full.lastIndexOf('\\'))
            targetPath = ucfDir + '\\' + elementPath.replace(/\//g, '\\')
        } else {
            targetPath = elementPath
        }

        if (!files.open(targetPath).exists) {
            serial.println(`Warning: External file not found: ${targetPath}`)
            continue
        }

        playerFile = getPlayerForFile(element.name)
    } else if (element.addressingMode === ADDRESSING_INTERNAL) {
        // Internal addressing - create temporary file reference
        let tempFile = createTempFileForInternal(element, fullFilePath.full)
        targetPath = tempFile.path
        playerFile = getPlayerForFile(element.name)

        // For internal addressing, we need to extract the data to a temporary location
        // or use a specialized player that can handle offset-based reading
        // Since we can't easily create temp files, we'll modify the exec_args for the player

        // Create a new UCF reader positioned at the file offset
        let fileReader = new UCFSequentialReader(fullFilePath.full, element.offset)

        // We need to somehow pass this to the player...
        // The most elegant solution is to create a wrapper that temporarily modifies
        // the file system view or uses a custom SequentialFileBuffer

        // For now, let's use a simpler approach: save exec_args and restore them
        let originalExecArgs = [...exec_args]

        // Modify the global environment to provide the offset reader
        let originalFilesOpen = files.open

        files.open = function(path) {
            if (path === targetPath || path.endsWith(targetPath)) {
                // Return a mock file object that uses our offset reader
                return {
                    exists: true,
                    size: 2147483648, // Arbitrary large size
                    path: path,
                    _ucfReader: fileReader
                }
            }
            return originalFilesOpen.call(this, path)
        }

        // Also modify seqread require to use our reader
        let originalRequire = require
        require = function(moduleName) {
            if (moduleName === "seqread" || moduleName === "seqreadtape") {
                return {
                    prepare: function(path) {
                        if (path === targetPath || path.endsWith(targetPath)) {
                            // Already prepared in fileReader
                            return 0
                        }
                        return fileReader.seq.prepare(path)
                    },
                    readBytes: function(length, ptr) { return fileReader.readBytes(length, ptr) },
                    readOneByte: function() { return fileReader.readOneByte() },
                    readShort: function() { return fileReader.readShort() },
                    readInt: function() { return fileReader.seq.readInt() },
                    readFourCC: function() { return fileReader.seq.readFourCC() },
                    readString: function(length) { return fileReader.readString(length) },
                    skip: function(n) { return fileReader.skip(n) },
                    getReadCount: function() { return fileReader.getPosition() },
                    fileHeader: fileReader.seq.fileHeader
                }
            }
            return originalRequire.call(this, moduleName)
        }

        try {
            // Execute the player with modified environment
            exec_args[1] = targetPath
            if (playerFile) {
                let playerPath = `A:\\tvdos\\bin\\${playerFile}.js`
                if (files.open(playerPath).exists) {
                    eval(files.readText(playerPath))
                } else {
                    serial.println(`Warning: Player not found: ${playerFile}`)
                }
            } else {
                serial.println(`Warning: No player found for file type: ${element.name}`)
            }
        } catch (e) {
            serial.println(`Error playing ${element.name}: ${e.message}`)
        } finally {
            // Restore original environment
            files.open = originalFilesOpen
            require = originalRequire
            exec_args = originalExecArgs
        }

        continue
    }

    if (!playerFile) {
        serial.println(`Warning: No player found for file type: ${element.name}`)
        continue
    }

    // Execute the appropriate player
    let playerPath = `A:\\tvdos\\bin\\${playerFile}.js`
    if (!files.open(playerPath).exists) {
        serial.println(`Warning: Player script not found: ${playerPath}`)
        continue
    }

    // Save and modify exec_args for the player
    let originalExecArgs = [...exec_args]
    exec_args[1] = targetPath

    try {
        eval(files.readText(playerPath))
    } catch (e) {
        serial.println(`Error playing ${element.name}: ${e.message}`)
    } finally {
        // Restore original exec_args
        exec_args = originalExecArgs
    }
}

serial.println("\nUCF playback completed")
return 0