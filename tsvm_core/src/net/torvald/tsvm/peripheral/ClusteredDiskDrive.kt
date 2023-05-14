package net.torvald.tsvm.peripheral

import net.torvald.tsvm.VM
import java.util.UUID

/**
 * `theArchivePath` must always be specified (where to load/save)
 *
 * To denote formatted (=already created) disk:
 * - specify diskUUIDstr
 * - set sectorsForNewDisk as -1
 * - set deviceOrigin and deviceTier as 0
 *
 * To denote unformatted (=not yet created) disk:
 * - set diskUUIDstr as ""
 * - specify sectorsForNewDisk
 * - specify deviceOrigin and deviceTier
 *
 * Created by minjaesong on 2023-05-15.
 */
class ClusteredDiskDrive(
    private val vm: VM,
    private val driveNum: Int,
    private val theArchivePath: String,
    private val diskUUIDstr: String,
    private val sectorsForNewDisk: Int,
    private val deviceOrigin: Int,
    private val deviceTier: Int
) {

    private var uuid: UUID? = if (diskUUIDstr.isEmpty()) null else UUID.fromString(diskUUIDstr)


}