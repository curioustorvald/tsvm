var w = 560;
var h = 448;
var hwoff = 1048576;

function inthash(x) {
    x = ((x >> 16) ^ x) * 0x45d9f3b;
    x = ((x >> 16) ^ x) * 0x45d9f3b;
    x = (x >> 16) ^ x;
    return x;
}

var rng = Math.floor(Math.random() * 2147483647) + 1;

while (!con.hitterminate()) {

    var tstart = sys.nanoTime();

    for (var y = 0; y < 360; y++) {
        for (var x = 0; x < w; x++) {
            var palnum = 20 * Math.floor(y / 30) + Math.floor(x / 28);
            sys.poke(-(y * w + x + 1) - hwoff, inthash(palnum + rng));
        }
    }

    for (var y = 360; y < h; y++) {
        for (var x = 0; x < w; x++) {
            var palnum = 240 + Math.floor(x / 35);
            sys.poke(-(y * w + x + 1) - hwoff, palnum);
        }
    }

    /*for (var k = 0; k < 2560; k++) {
        sys.poke(-(253952 + k + 1) - hwoff, -2); // transparent
        sys.poke(-(253952 + 2560 + k + 1) - hwoff, -1); // white
        /*sys.poke(-(253952 + 2560*2 + k + 1) - hwoff, Math.round(Math.random() * 255));*/
    //}*/

    rng = inthash(rng);

    var tend = sys.nanoTime();

    println("Apparent FPS: " + (1000000000 / (tend - tstart)));
}
