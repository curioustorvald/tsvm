let [blockSize, blockCount] = sys.getMallocStatus()
println(`${blockSize * blockCount} bytes allocated (${blockCount} blocks with ${blockSize} bytes per block)`)