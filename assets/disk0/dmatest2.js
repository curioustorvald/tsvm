con.clear()
com.sendMessage(0, 'CLOSE')
com.sendMessage(0, 'OPENR"fox.bytes"')
let status = com.getStatusCode(0)
if (0 == status) {
  println("DMA reading from disk...")
  let t1 = sys.nanoTime()
  dma.comToRam(0, 0, 0, 560 * 448)
  let t2 = sys.nanoTime()
  println("DMA copying to the framebuffer...")
  let t3 = sys.nanoTime()
  dma.ramToFrame(0, 0, 560 * 448)
  let t4 = sys.nanoTime()

  println(`DMA disk-to-RAM time: ${(t2 - t1) / 1000000} ms`)
  println(`DMA RAM-to-fbuf time: ${(t4 - t3) / 1000000} ms`)
}
else {
  printerrln(`File 'fox.bytes' not found on the root of the disk: ${status}`)
}