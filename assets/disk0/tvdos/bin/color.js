let backs = {
0:[0,0,0],
1:[2,1,10],
2:[2,6,3],
3:[4,9,12],
4:[12,3,3],
5:[12,4,12],
6:[12,10,0],
7:[10,10,10],

8:[5,5,5],
9:[5,3,15],
'A':[5,12,3],
'B':[8,15,15],
'C':[15,6,6],
'D':[15,9,15],
'E':[15,15,0],
'F':[15,15,15],

'G':[2,3,4],
'H':[2,4,3],
'I':[3,2,4],
'J':[3,4,2],
'K':[4,2,3],
'L':[4,3,2]
}
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
    _G.shell.usrcfg.textCol = fo
    con.color_pair(fo, 255)
}