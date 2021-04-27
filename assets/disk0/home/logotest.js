var imageBits = gzip.decomp(base64.atob(
"H4sICPx7h2ACA3RhbmRlbV9sb2dvXzI0MC5iaW4A7dQ/boMwFAbwz3Ikd4jitUMleoSOGaL6Kj1Cxg6V8NF8FI7AyIBwPv8hOA6kW6Y8IST4WWC/92zvX/GMsABEj9Y7+BEdoD1vUICfIKJ2MNQ2qqhVlop2XU1Sk5WDoyqHZtFmXZukulJtOdOrqqxmuFGdVFbabCpT4D2fqIqqvBW8hVdNP+vnot2Gyqh9rRPOclFk5coKfRNRh1pHnMUjHah7RB1nZQbX9CekgBPl14IOGODdAX/ryj/eq7RJe2rrNE6lfkn7nlRO/6v9uFGBpB3V1HoUvKIqH5RrWtXQa4umbByR1e042OluV2byBPwm3T9Se2DOne5RVnBDc/W/EbIftIk6oOycq3L+rFdWe6fGBh1RdqyBmJUJ2dIpqHR6QrlTFm1ZiKvmXWasjDoGFU57lDt0Q02tns1DteXJYJyKOgTFrPOpcqeuPJGSvuIpcQH1GZbNgAcAAA=="
));
for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 30; x++) {
        let word = imageBits[y * 30 + x];
        for (let i = 0; i < 8; i++) {
            graphics.plotPixel(8*x + i, y, ((word >>> (7 - i)) & 1 != 0) ? 255 : 239);
        }
    }
}

// wait arbitrary time
for (let b=0;b<333333;b++) {
    sys.poke(0,(Math.random()*255)|0);
    sys.poke(0,0);
}
con.clear();
graphics.clearPixels(255);
