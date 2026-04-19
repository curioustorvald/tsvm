const taud = require("taud")

const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
if (fullFilePath === undefined) {
    println(`Usage: ${exec_args[0]} path_to.taud`)
    return 1
}

const PLAYHEAD = 0

println("Playing "+fullFilePath.full)

audio.resetParams(PLAYHEAD)
audio.purgeQueue(PLAYHEAD)
audio.stop(PLAYHEAD)

taud.uploadTaudFile(fullFilePath.full, 0, PLAYHEAD)
audio.setMasterVolume(PLAYHEAD, 255)
audio.setMasterPan(PLAYHEAD, 128)
audio.setCuePosition(PLAYHEAD, 0)
audio.play(PLAYHEAD)