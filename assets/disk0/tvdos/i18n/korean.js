/*
 * A character is defined as one of:
 * 1. [I,x] (Initial only)
 * 2.1. [I,x,I,x] (Double Initial)
 * 2.2. [Ip,x,P,x] (Initial and Peak)
 * 3.1. [Ip,F,P,x] (Initial, Peak and one Final)
 * 3.2. [Ip,F1,P,F2] (Initial, Peak and complex Final)
 * 4.1. [I,x,Ip,x,P,x] (Double Initial and Peak)
 * 4.2. [I,x,Ip,F,P,x] (Double Initial, Peak and Final)
 * 4.3. [I,x,Ip,F1,P,F2] (Double Initial, Peak and complex Final)
 *
 * Index 0,2,4 is always top and 1,3,5 is always bottom row.
 *
 * ## Character Cell Numbering
 * +--+--+--+
 * |c0|c2|c4|
 * |c1|c3|c5|
 * +--+--+--+
 *
 *
 */

let charmap = {
i:{ // Cell Indices: [c0,c2]
// c0,c2:[ㄱ,ㄴ,ㄷ,ㄹ,...]
0:[0],
1:[0,0],
2:[1],
3:[2],
4:[2,2],
5:[3],
6:[4],
7:[5],
8:[5,5],
9:[6],
10:[6,6],
11:[7],
12:[8],
13:[8,8],
14:[9],
15:[10],
16:[11],
17:[12],
18:[13]
},p:{ // Cell Indices: [c2,c4], where c2 will be work as an multiplier
// c2:[null,ㅗ,ㅛ,ㅜ,ㅠ,ㅡ]
// c4:[0xC6,ㅏ,ㅐ,ㅑ,ㅒ,ㅓ,ㅔ,ㅕ,ㅖ,ㅘ,ㅙ,ㅚㅢㅟ,ㅝ,ㅞ,ㅣ]
0:[0,1],
1:[0,2],
2:[0,3],
3:[0,4],
4:[0,5],
5:[0,6],
6:[0,7],
7:[0,8],
8:[1,0],
9:[1,9],
10:[1,10],
11:[1,11],
12:[2,0],
13:[3,0],
14:[3,12],
15:[3,13],
16:[3,11],
17:[4,0],
18:[5,0],
19:[5,11],
20:[0,14]
},fvert:{ // Cell Indices: [c3,c5] for non-horizontal vowels (ㅏ,ㅐ,ㅑ,ㅒ and compound vowels)
// c3,c5:[null,ㄱ,ㄴ,ㄷ,...]
0:[0,0],
1:[0,1],
2:[1,1],
3:[1,7],
4:[0,2],
5:[2,9],
6:[2,14],
7:[0,3],
8:[0,4],
9:[4,1],
10:[4,5],
11:[4,6],
12:[4,7],
13:[4,12],
14:[4,13],
15:[4,14],
16:[0,5],
17:[0,6],
18:[6,7],
19:[0,7],
20:[7,7],
21:[0,8],
22:[0,9],
23:[0,10],
24:[0,11],
25:[0,12],
26:[0,13],
27:[0,14]
},fhorz:{ // Cell Indices: [c3,c5] for horizontal vowels (ㅗ,ㅛ,ㅜ,ㅠ,ㅡ)
// c3,c5:[null,ㄱ,ㄴ,ㄷ,...]
0:[0,0],
1:[1,0],
2:[1,1],
3:[1,7],
4:[2,0],
5:[2,9],
6:[2,14],
7:[3,0],
8:[4,0],
9:[4,1],
10:[4,5],
11:[4,6],
12:[4,7],
13:[4,12],
14:[4,13],
15:[4,14],
16:[5,0],
17:[6,0],
18:[6,7],
19:[7,0],
20:[7,7],
21:[8,0],
22:[9,0],
23:[10,0],
24:[11,0],
25:[12,0],
26:[13,0],
27:[14,0]
}}

let enc = {
i:[
0x80,0x81,0x82,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8a,0x8b,0x8c,0x8d,
0x90,0x91,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0x9b,0x9c,0x9d,
0xa0,0xa1,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xab,0xac,0xad,
0xe0,0xe1,0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xeb,0xec,0xed,
0xf0,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa,0xfb,0xfc,0xfd,
0xb7,0xb8,0xb9,0xba,0xbb,0xbc,0xbd,0xc7,0xc8,0xc9,0xca,0xcb,0xcc,0xcd
],p:[
0xc6,0x8e,0x8f,0xae,0xaf,0xce,0xcf,0xee,0xef,0xb0,0xb1,0xb2,0xb5,0xb6,0xfe
],f:[
0x20,0xd0,0xd1,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0x13,0x14,0x15,0x16,0x17
]
}

function toLineChar(i,p,f) {
    let out = []
    let ibuf = charmap.i[i]
    let pbuf = charmap.p[p]
    let fbuf = ([8,12,13,17,18].includes(p)) ? charmap.fhorz[f] : charmap.fvert[f]
    let dbl = 2*(ibuf.length == 2) // 0 or 2
    /* 0 | 0 */out[0] = ibuf[0]
    /* x | 2 */out[2] = ibuf[1]
    /* 2 | 4 */out[2+dbl] = pbuf[1]
    /*   |   */out[dbl] += pbuf[0]*14
    /* 1 | 3 */out[1+dbl] = fbuf[0]
    /* 3 | 5 */out[3+dbl] = fbuf[1]

    if (out.length > 4) {
        out[0] = enc.i[out[0]]
        out[1] = 0x20
        out[2] = enc.i[out[2]]
        out[3] = enc.f[out[3]]
        out[4] = enc.p[out[4]]
        out[5] = enc.f[out[5]]
    }
    else {
        out[0] = enc.i[out[0]]
        out[1] = enc.f[out[1]]
        out[2] = enc.p[out[2]]
        out[3] = enc.f[out[3]]
    }

    return out
}

let cursReturn = () => {
    let c = graphics.getCursorYX()
    con.move(c[0]-1,c[1]+1)
}

let printHangul = (char) => {
    char.forEach((v,i)=>{
        con.addch(v)
        if (i % 2 == 0)
            con.curs_down()
        else
            cursReturn()

        //if (graphics.getCursorYX()[1] == 1) con.curs_down();
    })
}

let printComma = (char) => {
    con.addch(char)
    con.curs_down()
    con.addch(127)
    cursReturn()
}

// load unicode module to the TVDOS
if (unicode.uniprint) {

    let [termh, termw] = con.getmaxyx()

    unicode.uniprint.unshift([
        c => 0x2C == c || 0x3B == c || (0xAC00 <= c && c <= 0xD7A3),
        c => {
            if (0x2C == c || 0x3B == c) {
                printComma(c)
            }
            else {
                let i = ((c - 0xAC00) / 588)|0
                let p = ((c - 0xAC00) / 28 % 21)|0
                let f = (c - 0xAC00) % 28
                let char = toLineChar(i,p,f)
                let w = Math.ceil(char.length / 2.0)|0
                if (con.getyx()[1] + w > termw) print('\n\n');
                printHangul(char)
            }
        }
    ])

    unicode.uniprint.unshift([
        c => 0x20 == c,
        c => {
            if (con.getyx()[1] >= termw) print('\n\n');
            else print(' ')
        }
    ])
}

