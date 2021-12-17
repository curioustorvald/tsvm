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

10: '\xD4', // ㅏ
11: '\xD5', // ㅐ
12: '\xD6', // ㅑ
13: '\xD7', // ㅒ
14: '\xB5', // ㅓ
15: '\xB6', // ㅔ
16: '\xB7', // ㅕ
17: '\xB8', // ㅖ
18: '\xBD', // ㅗ
19: '\xBE', // ㅛ
20: '\xC6', // ㅜ
21: '\xC7', // ㅠ
22: '\xD8', // ㅡ
23: '\xCF', // ㅣ

30: '\x9D', // ₩
}

let hangulIdisasm = [
'\xA6',
'\xA6\xA6',
'\xA7',
'\xA8',
'\xA8\xA8',
'\xA9',
'\xAA',
'\xAB',
'\xAB\xAB',
'\xAC',
'\xAC\xAC',
'\xAD',
'\xAE',
'\xAE\xAE',
'\xAF',
'\xD0',
'\xD1',
'\xD2',
'\xD3',
]

let hangulPdisasm = [
'\xD4',
'\xD5',
'\xD6',
'\xD7',
'\xB5',
'\xB6',
'\xB7',
'\xB8',
'\xBD',
'\xBD\xD4',
'\xBD\xD5',
'\xBD\xCF',
'\xBE',
'\xC6',
'\xC6\xB5',
'\xC6\xB6',
'\xC6\xCF',
'\xC7',
'\xD8',
'\xD8\xCF',
'\xCF',
]

let hangulFdisasm = [
'',
'\xA6',
'\xA6\xA6',
'\xA6\xAC',
'\xA7',
'\xA7\xAE',
'\xA7\xD3',
'\xA8',
'\xA9',
'\xA9\xA6',
'\xA9\xAA',
'\xA9\xAB',
'\xA9\xAC',
'\xA9\xD1',
'\xA9\xD2',
'\xA9\xD3',
'\xAA',
'\xAB',
'\xAB\xAC',
'\xAC',
'\xAC\xAC',
'\xAD',
'\xAE',
'\xAF',
'\xD0',
'\xD1',
'\xD2',
'\xD3',
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
        else if (0x20A9 == codepoint) s += '\x9D'
        else {
            s += String.fromCharCode(codepoint)
            if (0xAC00 <= c1 && c1 <= 0xD7A3) s += ' '
        }
    }

    return s
}

println(hangulDecode(utf8decode(str)))