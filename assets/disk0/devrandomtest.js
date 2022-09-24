let f = files.open("$:/RND")
let mlen = 512
let m = sys.malloc(mlen)

println(f.driverID)
println(`Ptr: ${m}`)

f.pread(m, mlen, 0)
f.close()

for (let i = 0; i < mlen; i++) {
    print(sys.peek(m+i).toString(16).padStart(2,'0'))
    print(' ')
}
println()

sys.free(m)