let backs = {0:[0,0,0],1:[3,2,15],2:[3,9,4],3:[6,13,15],4:[15,4,4],5:[15,6,15],6:[15,13,0],7:[14,14,14]}
let fores = {0:240,1:49,2:61,3:114,4:211,5:219,6:230,7:254}

if (exec_args[1]) {
    let b = exec_args[1][0].toUpperCase()
    let f = exec_args[1][1].toUpperCase()

    if (b == f) return 1
    let ba = backs[b]
    let fo = fores[f]

    if (!ba || !fo) return 2

    serial.println(fo)

    graphics.setBackground(ba[0], ba[1], ba[2])
    con.color_pair(fo, 255)
}