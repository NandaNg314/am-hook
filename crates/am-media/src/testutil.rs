//! Builders for small synthetic MP4 files used by the unit tests.

use crate::bmff::FourCC;

pub fn leaf(kind: &FourCC, payload: &[u8]) -> Vec<u8> {
    let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    v.extend_from_slice(kind);
    v.extend_from_slice(payload);
    v
}

pub fn full(kind: &FourCC, version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut p = ((version as u32) << 24 | flags).to_be_bytes().to_vec();
    p.extend_from_slice(body);
    leaf(kind, &p)
}

pub fn be(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_be_bytes()).collect()
}

pub struct TrackSpec {
    pub id: u32,
    pub timescale: u32,
    /// Sample entry box (type + payload), e.g. an mp4a or an encrypted enca.
    pub entry: Vec<u8>,
}

/// A plain audio-like sample entry of the given type.
pub fn entry(kind: &FourCC) -> Vec<u8> {
    leaf(kind, &[0u8; 28])
}

/// ftyp + moov (mvhd, one trak per spec, mvex with trex).
pub fn init(tracks: &[TrackSpec]) -> Vec<u8> {
    let mut moov = full(b"mvhd", 0, 0, &[be(&[0, 0, 1000, 0, 0x0001_0000]), vec![1, 0], vec![0; 10], vec![0; 36], vec![0; 24], be(&[99])].concat());
    for t in tracks {
        let tkhd = full(b"tkhd", 0, 3, &[be(&[0, 0, t.id, 0, 0]), vec![0; 60]].concat());
        let mdhd = full(b"mdhd", 0, 0, &[be(&[0, 0, t.timescale, 0]), vec![0x55, 0xc4, 0, 0]].concat());
        let hdlr = full(b"hdlr", 0, 0, &[be(&[0]), b"soun".to_vec(), vec![0; 12], b"test\0".to_vec()].concat());
        let stsd = full(b"stsd", 0, 0, &[be(&[1]), t.entry.clone()].concat());
        let stbl = leaf(
            b"stbl",
            &[stsd, full(b"stts", 0, 0, &be(&[0])), full(b"stsc", 0, 0, &be(&[0])), full(b"stsz", 0, 0, &be(&[0, 0])), full(b"stco", 0, 0, &be(&[0]))].concat(),
        );
        let minf = leaf(b"minf", &stbl);
        moov.extend(leaf(b"trak", &[tkhd, leaf(b"mdia", &[mdhd, hdlr, minf].concat())].concat()));
    }
    let trexs: Vec<u8> = tracks.iter().flat_map(|t| full(b"trex", 0, 0, &be(&[t.id, 1, 0, 0, 0]))).collect();
    moov.extend(leaf(b"mvex", &trexs));
    [leaf(b"ftyp", b"iso6\0\0\0\0iso6"), leaf(b"moov", &moov)].concat()
}

pub struct Run {
    pub track: u32,
    pub start_time: u64,
    /// (duration, flags, data) per sample.
    pub samples: Vec<(u32, u32, Vec<u8>)>,
}

/// One moof + mdat. Each run becomes a trun of its track's traf (one traf per
/// track, in first-appearance order); sample data is laid out in run order, so
/// runs of different tracks interleave in mdat. `extra` boxes are appended to
/// each traf (e.g. senc), keyed by track.
pub fn fragment(sequence: u32, runs: &[Run], extra: &dyn Fn(u32) -> Vec<u8>) -> Vec<u8> {
    let mut tracks: Vec<u32> = Vec::new();
    for r in runs {
        if !tracks.contains(&r.track) {
            tracks.push(r.track);
        }
    }
    // First pass with zero offsets to learn the moof size.
    let build = |offsets: &[i32]| {
        let mut moof = full(b"mfhd", 0, 0, &be(&[sequence]));
        for &t in &tracks {
            let mut traf = full(b"tfhd", 0, 0x020000, &be(&[t]));
            let start = runs.iter().find(|r| r.track == t).unwrap().start_time;
            traf.extend(full(b"tfdt", 1, 0, &start.to_be_bytes()));
            for (i, r) in runs.iter().enumerate().filter(|(_, r)| r.track == t) {
                let mut body = be(&[r.samples.len() as u32, offsets[i] as u32]);
                for (d, f, data) in &r.samples {
                    body.extend(be(&[*d, data.len() as u32, *f]));
                }
                traf.extend(full(b"trun", 0, 0x701, &body));
            }
            traf.extend(extra(t));
            moof.extend(leaf(b"traf", &traf));
        }
        leaf(b"moof", &moof)
    };
    let size = build(&vec![0; runs.len()]).len();
    let mut offsets = Vec::new();
    let mut at = size + 8;
    for r in runs {
        offsets.push(at as i32);
        at += r.samples.iter().map(|s| s.2.len()).sum::<usize>();
    }
    let data: Vec<u8> = runs.iter().flat_map(|r| r.samples.iter().flat_map(|s| s.2.clone())).collect();
    [build(&offsets), leaf(b"mdat", &data)].concat()
}

/// Sample data unique per track and sample, so misplaced bytes are detected.
pub fn sample_data(track: u32, i: usize) -> Vec<u8> {
    [track as u8, i as u8, (i >> 8) as u8].repeat(10 + i % 7)
}
