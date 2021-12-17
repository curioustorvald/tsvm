//sys.poke(-1299460, 19) // map the font ROM to the mapping area
//sys.poke(-1299460, 19) // write to the font ROM

let chrmap = {
 0: '\xA6', // ㄱ
 1: '\xA7', // ㄴ
 2: '\xA8', // ㄷ
 3: '\xA9', // ㄹ
 4: '\xAA', // ㅁ
 5: '\xAB', // ㅂ
 6: '\xAC', // ㅅ
 7: '\xAD', // ㅇ
 8: '\xAE', // ㅈ
 9: '\xAF', // ㅊ
10: '\xD0', // ㅋ
11: '\xD1', // ㅌ
12: '\xD2', // ㅍ
13: '\xD3', // ㅎ

20: '\xD4', // ㅏ
21: '\xD5', // ㅐ
22: '\xD6', // ㅑ
23: '\xD7', // ㅒ
24: '\xB5', // ㅓ
25: '\xB6', // ㅔ
26: '\xB7', // ㅕ
27: '\xB8', // ㅖ
28: '\xBD', // ㅗ
29: '\xBE', // ㅛ
30: '\xC6', // ㅜ
31: '\xC7', // ㅠ
32: '\xD8', // ㅡ
33: '\xCF', // ㅣ

50: '\x9D', // ₩
}

let hangulIdisasm = [
chrmap[0],
chrmap[0]+chrmap[0],
chrmap[1],
chrmap[2],
chrmap[2]+chrmap[2],
chrmap[3],
chrmap[4],
chrmap[5],
chrmap[5]+chrmap[5],
chrmap[6],
chrmap[6]+chrmap[6],
chrmap[7],
chrmap[8],
chrmap[8]+chrmap[8],
chrmap[9],
chrmap[10],
chrmap[11],
chrmap[12],
chrmap[13],
]

let hangulPdisasm = [
chrmap[20],
chrmap[21],
chrmap[22],
chrmap[23],
chrmap[24],
chrmap[25],
chrmap[26],
chrmap[27],
chrmap[28],
chrmap[18]+chrmap[10],
chrmap[18]+chrmap[11],
chrmap[18]+chrmap[33],
chrmap[29],
chrmap[30],
chrmap[30]+chrmap[24],
chrmap[30]+chrmap[25],
chrmap[30]+chrmap[33],
chrmap[31],
chrmap[32],
chrmap[32]+chrmap[33],
chrmap[33],
]

let hangulFdisasm = [
'',
chrmap[0],
chrmap[0]+chrmap[0],
chrmap[0]+chrmap[6],
chrmap[1],
chrmap[1]+chrmap[8],
chrmap[1]+chrmap[13],
chrmap[2],
chrmap[3],
chrmap[3]+chrmap[0],
chrmap[3]+chrmap[4],
chrmap[3]+chrmap[5],
chrmap[3]+chrmap[6],
chrmap[3]+chrmap[11],
chrmap[3]+chrmap[12],
chrmap[3]+chrmap[13],
chrmap[4],
chrmap[5],
chrmap[5]+chrmap[6],
chrmap[6],
chrmap[6]+chrmap[6],
chrmap[7],
chrmap[8],
chrmap[9],
chrmap[10],
chrmap[11],
chrmap[12],
chrmap[13],
]

let UTF8_ACCEPT = 0
let UTF8D = [
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,  9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,
    7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
    8,8,2,2,2,2,2,2,2,2,2,2,2,2,2,2,  2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
    10,3,3,3,3,3,3,3,3,3,3,3,3,4,3,3, 11,6,6,6,5,8,8,8,8,8,8,8,8,8,8,8,
    0,12,24,36,60,96,84,12,12,12,48,72, 12,12,12,12,12,12,12,12,12,12,12,12,
    12, 0,12,12,12,12,12, 0,12, 0,12,12, 12,24,12,12,12,12,12,24,12,24,12,12,
    12,12,12,12,12,12,12,24,12,12,12,12, 12,24,12,12,12,12,12,12,12,24,12,12,
    12,12,12,12,12,12,12,36,12,36,12,12, 12,36,12,12,12,12,12,36,12,36,12,12,
    12,36,12,12,12,12,12,12,12,12,12,12,
]

/**
 * @param utf8text A JS string in UTF-8
 * @return array of Unicode codepoints
 */
function utf8decode(utf8text) {
    var state = UTF8_ACCEPT
    var codep = 0
    var codepoints = []

    for (let i=0; i < utf8text.length; i++) {
        let byte = utf8text.charCodeAt(i)
        let type = UTF8D[byte]
        codep = (state != UTF8_ACCEPT) ?
            (byte & 0x3f) | (codep << 6) : (0xff >> type) & (byte)
        state = UTF8D[256 + state + type]
        if (state == UTF8_ACCEPT)
            codepoints.push(codep)
    }
    return codepoints
}

let str = "한글 TVDOS 0마당 3고개" // in utf-8 for TSVM

/**
 * @param codepoint A single Unicode character in codepoint
 * @return A string representation of the character in TSVM codepage converted from the codepoint
 */
function hangulDecode(codepoints) {
    let s = ''

    for (let i = 0; i < codepoints.length; i++) {
        let codepoint = codepoints[i]
        let c1 = codepoints[i+1]


        serial.println(codepoint.toString(16))
        serial.println(String.fromCharCode(codepoint))


        if (0xAC00 <= codepoint && codepoint <= 0xD7A3) {
            let i = ((codepoint - 0xAC00) / 588)|0
            let p = ((codepoint - 0xAC00) / 28 % 21)|0
            let f = (codepoint - 0xAC00) % 28
            s += (hangulIdisasm[i] + hangulPdisasm[p] + hangulFdisasm[f])
            if (0xAC00 <= c1 && c1 <= 0xD7A3) s += ' '
        }
        else if (0x20A9 == codepoint) s += chrmap[50]
        else {
            s += String.fromCharCode(codepoint)
            if (0xAC00 <= c1 && c1 <= 0xD7A3) s += ' '
        }
    }

    return s
}

println(hangulDecode(utf8decode(str)))