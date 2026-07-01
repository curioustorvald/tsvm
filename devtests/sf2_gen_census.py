#!/usr/bin/env python3
"""sf2_gen_census.py — census of generators + modulators actually used by .sf2
files, and a detailed zone dump for named presets, to ground the
"what the spec allows vs what files do" table.
"""
import struct, sys, collections

GEN_NAMES = {
 0:'startAddrsOffset',1:'endAddrsOffset',2:'startloopAddrsOffset',
 3:'endloopAddrsOffset',4:'startAddrsCoarseOffset',5:'modLfoToPitch',
 6:'vibLfoToPitch',7:'modEnvToPitch',8:'initialFilterFc',9:'initialFilterQ',
 10:'modLfoToFilterFc',11:'modEnvToFilterFc',12:'endAddrsCoarseOffset',
 13:'modLfoToVolume',15:'chorusEffectsSend',16:'reverbEffectsSend',17:'pan',
 21:'delayModLFO',22:'freqModLFO',23:'delayVibLFO',24:'freqVibLFO',
 25:'delayModEnv',26:'attackModEnv',27:'holdModEnv',28:'decayModEnv',
 29:'sustainModEnv',30:'releaseModEnv',31:'keynumToModEnvHold',
 32:'keynumToModEnvDecay',33:'delayVolEnv',34:'attackVolEnv',35:'holdVolEnv',
 36:'decayVolEnv',37:'sustainVolEnv',38:'releaseVolEnv',39:'keynumToVolEnvHold',
 40:'keynumToVolEnvDecay',41:'instrument',43:'keyRange',44:'velRange',
 45:'startloopAddrsCoarse',46:'keynum',47:'velocity',48:'initialAttenuation',
 50:'endloopAddrsCoarse',51:'coarseTune',52:'fineTune',53:'sampleID',
 54:'sampleModes',56:'scaleTuning',57:'exclusiveClass',58:'overridingRootKey',
}

def _u16(b,o): return struct.unpack_from('<H',b,o)[0]

def read_pdta(path):
    f=open(path,'rb'); hdr=f.read(12)
    if hdr[:4]!=b'RIFF' or hdr[8:12]!=b'sfbk': sys.exit("bad sf2")
    end=8+struct.unpack_from('<I',hdr,4)[0]; pdta={}; pos=12
    while pos+8<=end:
        f.seek(pos); ch=f.read(8)
        if len(ch)<8: break
        cid,sz=ch[:4],struct.unpack_from('<I',ch,4)[0]
        if cid==b'LIST':
            lt=f.read(4); inner,ie=pos+12,pos+8+sz
            while inner+8<=ie:
                f.seek(inner); sh=f.read(8); scid,ssz=sh[:4],struct.unpack_from('<I',sh,4)[0]
                if lt==b'pdta': pdta[scid.decode('latin-1')]=f.read(ssz)
                inner+=8+ssz+(ssz&1)
        pos+=8+sz+(sz&1)
    f.close(); return pdta

def census(path):
    pdta=read_pdta(path)
    gen_count=collections.Counter()
    # generators in igen + pgen
    for key in ('igen','pgen'):
        g=pdta[key]
        for i in range(len(g)//4):
            oper,_=struct.unpack_from('<HH',g,i*4)
            gen_count[oper]+=1
    # modulators: imod + pmod records are 10 bytes:
    # srcOper(2) destOper(2) amount(2) amtSrcOper(2) transOper(2)
    mod_count=collections.Counter()
    mod_total=0
    for key in ('imod','pmod'):
        m=pdta.get(key,b'')
        n=len(m)//10
        for i in range(n):
            src,dest,amt,amtsrc,trans=struct.unpack_from('<HHhHH',m,i*10)
            if (src,dest,amt,amtsrc,trans)==(0,0,0,0,0):  # terminal
                continue
            mod_total+=1
            mod_count[(src,dest,amtsrc)]+=1
    return gen_count, mod_count, mod_total

def decode_modsrc(s):
    # SF2 modulator source enumeration (sfModulator bitfield)
    cc = (s>>7)&1
    idx = s & 0x7F
    direction = (s>>8)&1
    polarity = (s>>9)&1
    typ = (s>>10)&0x3F
    tn = {0:'linear',1:'concave',2:'convex',3:'switch'}.get(typ,f'curve{typ}')
    if cc:
        name=f'CC{idx}'
    else:
        gp={0:'None',2:'NoteOnVel',3:'NoteOnKey',10:'PolyPress',13:'ChanPress',
            14:'PitchWheel',16:'PitchWheelSens'}.get(idx,f'gen{idx}')
        name=gp
    return f'{name}[{tn}{"-" if direction else "+"}{"bi" if polarity else "uni"}]'

def main():
    for p in sys.argv[1:]:
        gc,mc,mtot=census(p)
        print("="*78); print("FILE:",p)
        print(f"  total non-terminal modulators: {mtot}")
        print("  GENERATOR usage (count across igen+pgen):")
        for oper in sorted(gc):
            nm=GEN_NAMES.get(oper,f'?{oper}')
            print(f"    {oper:3d} {nm:<24s} {gc[oper]}")
        print("  MODULATOR usage (src -> dest, by amtSrc):")
        for (src,dest,amtsrc),c in mc.most_common():
            dn=GEN_NAMES.get(dest,f'gen{dest}') if dest<512 else f'link{dest}'
            print(f"    {decode_modsrc(src):<28s} -> {dn:<20s} "
                  f"amtSrc={decode_modsrc(amtsrc):<20s} x{c}")

if __name__=='__main__':
    main()
