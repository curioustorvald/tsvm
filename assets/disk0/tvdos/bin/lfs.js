function printUsage() {
    println(`Collects files under a directory into a single archive.
Usage: lfs [-c/-x/-t] dest.lfs path\\to\\source
To collect a directory into myarchive.lfs:
       lfs -c myarchive.lfs path\\to\\directory
To extract an archive to path\\to\\my\\files:
       lfs -x myarchive.lfs \\path\\to\\my\\files
To list the collected files:
       lfs -t`)
}

const option = exec_args[1]
const lfsPath = exec_args[2]
const dirPath = exec_args[3]


if (option === undefined || lfsPath === undefined || option.toUpperCase() != "-T" && dirPath === undefined) {
    printUsage()
    return 0
}

