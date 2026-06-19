#!/usr/bin/env fish

for f in *.mod; python3 mod2taud.py $f assets/disk0/home/music/(basename $f .mod).taud; end
for f in *.MOD; python3 mod2taud.py $f assets/disk0/home/music/(basename $f .MOD).taud; end
for f in *.s3m; python3 s3m2taud.py $f assets/disk0/home/music/(basename $f .s3m).taud; end
for f in *.S3M; python3 s3m2taud.py $f assets/disk0/home/music/(basename $f .S3M).taud; end
for f in *.it; python3 it2taud.py $f assets/disk0/home/music/(basename $f .it).taud; end
for f in *.IT; python3 it2taud.py $f assets/disk0/home/music/(basename $f .IT).taud; end
for f in *.xm; python3 xm2taud.py $f assets/disk0/home/music/(basename $f .xm).taud; end
for f in *.XM; python3 xm2taud.py $f assets/disk0/home/music/(basename $f .XM).taud; end
for f in *.mon; python3 mon2taud.py $f assets/disk0/home/music/(basename $f .mon).taud; end
for f in *.MON; python3 mon2taud.py $f assets/disk0/home/music/(basename $f .MON).taud; end

for f in *.mid; python3 midi2taud.py $f GeneralUser-GS.sf2 assets/disk0/home/music/(basename $f .mid).taud --force-synth-loop; end
for f in *.MID; python3 midi2taud.py $f GeneralUser-GS.sf2 assets/disk0/home/music/(basename $f .MID).taud --force-synth-loop; end
for f in *.midi; python3 midi2taud.py $f GeneralUser-GS.sf2 assets/disk0/home/music/(basename $f .midi).taud --force-synth-loop; end
