// synopsis: sysctl {reset|...} target


const verbs = {
    "reset": ["Reset", "Resetting"]
}
const actions = {
    "reset": {
        "mmu": ()=>{
            for (let k = 0; k < sys.maxmem(); k += 64) {
                try {
                    sys.free(k)
                }
                catch (e) {}
            }
        },
        "graphics": ()=>{
            graphics.resetPalette()
            con.reset_graphics()
            graphics.clearPixels(255)
            graphics.clearPixels2(240)
            graphics.setGraphicsMode(0)
            graphics.setBackground(34,51,68)
            sys.poke(-1299460, 20)
            sys.poke(-1299460, 21)
        }
        "audio": ()=>{
            for (let k = 0; k < 4; k++) {
                audio.stop(k)
                audio.purgeQueue(k)
                audio.resetParams(k)
            }
        }
    }
}

const verb = exec_args[1]
const target = exec_args[2]

if (verb && !target) {
    println(`sysctl: no target specified for ${verbs[verb][1]}`)
    return 1
}
if (!verb) {
    println("Usage: sysctl {reset|...} target")
    return 10
}

let actionfun = actions[verb][target]
if (actionfun) actionfun()
else {
    printerrln(`sysctl: unknown target ${target}`)
    return 1
}
