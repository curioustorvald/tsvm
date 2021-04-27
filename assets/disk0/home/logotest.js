con.curs_set(0)
con.clear()
let t=`${system.maxmem()>>>10} Kbytes System`
let imageBits = gzip.decomp(base64.atob(
"H4sICC62h2ACA3RhbmRlbV9sb2dvXzI0MC5iaW4AhdQ/bsMgGAXwh4hEhyisHSq5R+iYISpX6REydqhkjsZRfASPDJbJ449jQuxUspDsn2XD+z6wAMSIPjiECQOgAwcoIMwQNuoAQ+2TilZlrehbdeioJqspypeTqgfttrXLqhvVljO9qypq/IPqrLLRblcZQQi8oyqqClZwiI+6cdHPVYcdlUnHVmdc5aooypVV+iaS+lYnXMUr9dQjkk6LMsEt/YkRcKL8WlQPj+BO+NtW/vFZpc06Ununcan1S9r3rHL+X+3HgwpkHaim1bPglVSFqFzTpsZeWzWncUZRd+DLTg+HOskL8Jv1+ErtiZk7PaKu4I6W6n8jph+1S+pRd85dOX/Wq6h9UmOjTqg71kAsykD2dI4qnZ5R75RVexbirmWXGSuTTlGF0wH1Dt1R02pg81BtfTIYp5L6qFh0OVWe1NUnUtIb4Dr/QbAEAAA="
))
for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 30; x++) {
        let octet = imageBits[y * 30 + x]
        for (let i = 0; i < 8; i++) {
            graphics.plotPixel(8*x + i, y+8, ((octet >>> (7 - i)) & 1 != 0) ? 255 : 239)
        }
    }
}
con.move(8,1)