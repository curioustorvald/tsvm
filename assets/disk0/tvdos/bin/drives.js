Object.entries(_TVDOS.DRIVES).forEach(it=>{
    let [letter, [port, drivenum]] = it
    let dinfo = _TVDOS.DRIVEINFO[letter]
    println(`${letter}: COM${port+1},${drivenum} (${dinfo.name}-${dinfo.type})`)
})
