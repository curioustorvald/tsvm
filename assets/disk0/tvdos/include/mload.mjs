/*
Loads files into the memory and returns their respective pointers. If the file was failed to load (file not found or
out of memory), `null` will be used instead.

The path must be an absolute path including drive letter.

This program is not meant to be used by the end user, but the creators of packaged apps where the simple and easy way of
pre-loading resources (e.g. graphical assets) into the memory is desirable.

This library requires TVDOS.SYS to be loaded.
 */


exports = function mload(paths) {
    return paths.map(path => {
        let f = files.open(path)
        let flen = f.size
        try {
            let p = sys.malloc(flen)
            f.pread(p, flen, 0)
            return p
        }
        catch (e) {
            return null
        }
    })
}