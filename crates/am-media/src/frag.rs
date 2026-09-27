//! Typed views of the fragment boxes (tfhd, trun, trex, tfdt, sbgp) shared by the
//! decryption, caption repair and defragmentation code.

use crate::bmff::{be32, put32, put64, Atom, Reader};
use crate::{bail, Error, Result};

pub const TFHD_BASE_DATA_OFFSET: u32 = 0x01;
pub const TFHD_SAMPLE_DESCRIPTION_INDEX: u32 = 0x02;
pub const TFHD_DEFAULT_DURATION: u32 = 0x08;
pub const TFHD_DEFAULT_SIZE: u32 = 0x10;
pub const TFHD_DEFAULT_FLAGS: u32 = 0x20;

pub const TRUN_DATA_OFFSET: u32 = 0x01;
pub const TRUN_FIRST_SAMPLE_FLAGS: u32 = 0x04;
pub const TRUN_DURATION: u32 = 0x100;
pub const TRUN_SIZE: u32 = 0x200;
pub const TRUN_FLAGS: u32 = 0x400;
pub const TRUN_CTO: u32 = 0x800;

#[derive(Clone, Debug, Default)]
pub struct Tfhd {
    pub track_id: u32,
    pub flags: u32,
    pub base_data_offset: Option<u64>,
    pub description: Option<u32>,
    pub duration: Option<u32>,
    pub size: Option<u32>,
    pub sample_flags: Option<u32>,
}

impl Tfhd {
    pub fn parse(atom: &Atom) -> Result<Tfhd> {
        let mut r = Reader::new(atom.bytes());
        let flags = r.u32()? & 0x00ff_ffff;
        let mut t = Tfhd { track_id: r.u32()?, flags, ..Tfhd::default() };
        if flags & TFHD_BASE_DATA_OFFSET != 0 {
            t.base_data_offset = Some(r.u64()?);
        }
        if flags & TFHD_SAMPLE_DESCRIPTION_INDEX != 0 {
            t.description = Some(r.u32()?);
        }
        if flags & TFHD_DEFAULT_DURATION != 0 {
            t.duration = Some(r.u32()?);
        }
        if flags & TFHD_DEFAULT_SIZE != 0 {
            t.size = Some(r.u32()?);
        }
        if flags & TFHD_DEFAULT_FLAGS != 0 {
            t.sample_flags = Some(r.u32()?);
        }
        Ok(t)
    }

    /// Rewrites the track ID in place.
    pub fn set_track_id(atom: &mut Atom, id: u32) -> Result<()> {
        let b = atom.bytes_mut();
        if b.len() < 8 {
            bail!("truncated tfhd");
        }
        put32(b, 4, id);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Trex {
    pub track_id: u32,
    pub description: u32,
    pub duration: u32,
    pub size: u32,
    pub flags: u32,
}

impl Trex {
    pub fn parse(atom: &Atom) -> Result<Trex> {
        let mut r = Reader::new(atom.bytes());
        r.u32()?;
        Ok(Trex { track_id: r.u32()?, description: r.u32()?, duration: r.u32()?, size: r.u32()?, flags: r.u32()? })
    }

    pub fn set_track_id(atom: &mut Atom, id: u32) -> Result<()> {
        let b = atom.bytes_mut();
        if b.len() < 8 {
            bail!("truncated trex");
        }
        put32(b, 4, id);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Sample {
    pub flags: u32,
    pub duration: u32,
    pub size: u32,
    pub cto: i32,
}

#[derive(Clone, Debug, Default)]
pub struct Trun {
    pub flags: u32,
    pub data_offset: i32,
    pub samples: Vec<Sample>,
}

impl Trun {
    pub fn has(&self, flag: u32) -> bool {
        self.flags & flag != 0
    }

    /// Decodes a trun with only the fields it carries; see [`Trun::fill_defaults`].
    pub fn parse(atom: &Atom) -> Result<Trun> {
        let b = atom.bytes();
        let mut r = Reader::new(b);
        let flags = r.u32()? & 0x00ff_ffff;
        let count = r.u32()?;
        let per = [TRUN_DURATION, TRUN_SIZE, TRUN_FLAGS, TRUN_CTO].iter().filter(|&&f| flags & f != 0).count() as u64 * 4;
        let fixed = 8 + if flags & TRUN_DATA_OFFSET != 0 { 4 } else { 0 } + if flags & TRUN_FIRST_SAMPLE_FLAGS != 0 { 4 } else { 0 };
        if b.len() as u64 != fixed + per * count as u64 {
            bail!("trun: expected size {}, got {}", fixed + per * count as u64 + 8, b.len() + 8);
        }
        if count > 1024 && per == 0 {
            bail!("trun: sampleCount {count} is big but no sample data present");
        }
        let mut t = Trun { flags, ..Trun::default() };
        if flags & TRUN_DATA_OFFSET != 0 {
            t.data_offset = r.u32()? as i32;
        }
        let first = if flags & TRUN_FIRST_SAMPLE_FLAGS != 0 { Some(r.u32()?) } else { None };
        t.samples.reserve(count as usize);
        for i in 0..count {
            let mut s = Sample::default();
            if flags & TRUN_DURATION != 0 {
                s.duration = r.u32()?;
            }
            if flags & TRUN_SIZE != 0 {
                s.size = r.u32()?;
            }
            if flags & TRUN_FLAGS != 0 {
                s.flags = r.u32()?;
            } else if let (Some(f), 0) = (first, i) {
                s.flags = f;
            }
            if flags & TRUN_CTO != 0 {
                s.cto = r.u32()? as i32;
            }
            t.samples.push(s);
        }
        Ok(t)
    }

    /// Fills fields absent from the trun from tfhd, then trex, and returns the total duration.
    pub fn fill_defaults(&mut self, tfhd: &Tfhd, trex: Option<&Trex>) -> u64 {
        let duration = tfhd.duration.or(trex.map(|t| t.duration)).unwrap_or(0);
        let size = tfhd.size.or(trex.map(|t| t.size)).unwrap_or(0);
        let flags = tfhd.sample_flags.or(trex.map(|t| t.flags)).unwrap_or(0);
        let (has_dur, has_size, has_flags, has_first) =
            (self.has(TRUN_DURATION), self.has(TRUN_SIZE), self.has(TRUN_FLAGS), self.has(TRUN_FIRST_SAMPLE_FLAGS));
        let mut total = 0;
        for (i, s) in self.samples.iter_mut().enumerate() {
            if !has_dur {
                s.duration = duration;
            }
            total += s.duration as u64;
            if !has_size {
                s.size = size;
            }
            if !has_flags && (i > 0 || !has_first) {
                s.flags = flags;
            }
        }
        total
    }

    /// Rewrites the data offset in place (no-op without the data-offset flag).
    pub fn set_data_offset(atom: &mut Atom, offset: i32) {
        let b = atom.bytes_mut();
        if b.len() >= 12 && be32(b, 0) & TRUN_DATA_OFFSET != 0 {
            put32(b, 8, offset as u32);
        }
    }

    pub fn data_offset(atom: &Atom) -> Option<i32> {
        let b = atom.bytes();
        (b.len() >= 12 && be32(b, 0) & TRUN_DATA_OFFSET != 0).then(|| be32(b, 8) as i32)
    }
}

/// tfdt base media decode time.
pub fn tfdt_time(atom: &Atom) -> Result<u64> {
    let b = atom.bytes();
    let mut r = Reader::new(b);
    if r.u8()? == 1 {
        r.take(3)?;
        r.u64()
    } else {
        r.take(3)?;
        Ok(r.u32()? as u64)
    }
}

/// Sets the tfdt time keeping its version, so the box size never changes
/// (version 0 stores the low 32 bits, like mp4ff).
pub fn set_tfdt_time(atom: &mut Atom, time: u64) -> Result<()> {
    let b = atom.bytes_mut();
    if b.first() == Some(&1) && b.len() >= 12 {
        put64(b, 4, time);
    } else if b.len() >= 8 {
        put32(b, 4, time as u32);
    } else {
        bail!("truncated tfdt");
    }
    Ok(())
}

#[derive(Clone, Debug, Default)]
pub struct Sbgp {
    pub version: u8,
    pub flags: u32,
    pub grouping_type: [u8; 4],
    pub parameter: u32,
    pub counts: Vec<u32>,
    pub indices: Vec<u32>,
}

impl Sbgp {
    pub fn parse(atom: &Atom) -> Result<Sbgp> {
        let mut r = Reader::new(atom.bytes());
        let vf = r.u32()?;
        let version = (vf >> 24) as u8;
        let mut s = Sbgp { version, flags: vf & 0x00ff_ffff, ..Sbgp::default() };
        s.grouping_type = r.take(4)?.try_into().unwrap();
        if version == 1 {
            s.parameter = r.u32()?;
        }
        let n = r.u32()?;
        for _ in 0..n {
            s.counts.push(r.u32()?);
            s.indices.push(r.u32()?);
        }
        Ok(s)
    }

    pub fn encode(&self) -> Atom {
        let mut b = crate::bmff::version_flags(self.version, self.flags).to_vec();
        b.extend_from_slice(&self.grouping_type);
        if self.version == 1 {
            b.extend_from_slice(&self.parameter.to_be_bytes());
        }
        b.extend_from_slice(&(self.counts.len() as u32).to_be_bytes());
        for (c, i) in self.counts.iter().zip(&self.indices) {
            b.extend_from_slice(&c.to_be_bytes());
            b.extend_from_slice(&i.to_be_bytes());
        }
        Atom::data(b"sbgp", b)
    }
}

/// Grouping type of an sgpd box.
pub fn sgpd_grouping_type(atom: &Atom) -> Option<[u8; 4]> {
    atom.bytes().get(4..8).map(|b| b.try_into().unwrap())
}

/// The tfhd of a traf, required.
pub fn traf_tfhd(traf: &Atom) -> Result<Tfhd> {
    Tfhd::parse(traf.child(b"tfhd").ok_or_else(|| Error::new("traf has no tfhd"))?)
}
