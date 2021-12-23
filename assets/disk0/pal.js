con.clear()
for (let i=0;i<256;i++) {
  graphics.plotPixel(200+(i%16),200+((i/16)|0),i)
}
