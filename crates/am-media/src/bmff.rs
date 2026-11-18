//! Minimal ISO BMFF box tree.
//!
//! Only the containers this crate edits are expanded; every other box keeps its
//! original payload bytes, so an unedited tree encodes back to the same bytes.

use crate::{Error, Result};

pub type FourCC = [u8; 4];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Atom {
    pub kind: FourCC,
    pub body: Body,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Body {
    /// Payload after the box header.
    Data(Vec<u8>),
    /// `head` holds the fields before the child boxes (e.g. stsd's entry count).
    Tree { head: Vec<u8>, children: Vec<Atom> },
}

/// Position of one box inside a byte buffer.
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub kind: FourCC,
    pub start: usize,
    pub header: usize,
    pub end: usize,
}

impl Span {
    pub fn payload(&self) -> std::ops::Range<usize> {
        self.start + self.header..self.end
    }
}

pub fn be16(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}
pub fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}
pub fn be64(b: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(b[at..at + 8].try_into().unwrap())
}
pub fn put32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_be_bytes());
}
pub fn put64(b: &mut [u8], at: usize, v: u64) {
    b[at..at + 8].copy_from_slice(&v.to_be_bytes());
}

pub fn fourcc(kind: &FourCC) -> String {
    String::from_utf8_lossy(kind).into_owned()
}

/// Reads a box header at `at`. `end` bounds the enclosing region.
pub fn header(data: &[u8], at: usize, end: usize) -> Result<Span> {
    if end - at < 8 {
        return Err(Error::new("truncated box header"));
    }
    let mut size = be32(data, at) as u64;
    let kind: FourCC = data[at + 4..at + 8].try_into().unwrap();
    let mut header = 8;
    if size == 1 {
        if end - at < 16 {
            return Err(Error::new("truncated large box header"));
        }
        size = be64(data, at + 8);
        header = 16;
    } else if size == 0 {
        size = (end - at) as u64;
    }
    if size < header as u64 || size > (end - at) as u64 {
        return Err(Error::msg(format!("invalid {} box size {size}", fourcc(&kind))));
    }
    Ok(Span { kind, start: at, header, end: at + size as usize })
}

/// Lists the boxes of `data[start..end]` without copying them.
pub fn spans(data: &[u8], start: usize, end: usize) -> Result<Vec<Span>> {
    let mut out = Vec::new();
    let mut at = start;
    while at < end {
        let s = header(data, at, end)?;
        at = s.end;
        out.push(s);
    }
    Ok(out)
}

/// Bytes before the children of a container box, or `None` for a leaf.
fn container_head(kind: &FourCC, payload: &[u8]) -> Option<usize> {
    match kind {
        b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"dinf" | b"edts" | b"mvex" | b"moof" | b"traf"
        | b"udta" | b"sinf" | b"schi" => Some(0),
        b"stsd" => Some(8),
        // Encrypted sample entries are expanded to reach their sinf.
        b"encv" => Some(78),
        b"enca" => match payload.get(8..10).map(|v| u16::from_be_bytes([v[0], v[1]])) {
            Some(1) => Some(44),
            Some(2) => Some(64),
            _ => Some(28),
        },
        // ISO meta has version/flags; mp4ff treats a payload starting with "hdlr" as QuickTime.
        b"meta" => Some(if payload.starts_with(b"hdlr") { 0 } else { 4 }),
        _ => None,
    }
}

pub fn parse(data: &[u8]) -> Result<Vec<Atom>> {
    spans(data, 0, data.len())?.iter().map(|s| Atom::from_span(data, s)).collect()
}

impl Atom {
    pub fn data(kind: &FourCC, payload: Vec<u8>) -> Atom {
        Atom { kind: *kind, body: Body::Data(payload) }
    }

    pub fn tree(kind: &FourCC, head: Vec<u8>, children: Vec<Atom>) -> Atom {
        Atom { kind: *kind, body: Body::Tree { head, children } }
    }

    pub fn from_span(data: &[u8], s: &Span) -> Result<Atom> {
        let payload = &data[s.payload()];
        match container_head(&s.kind, payload) {
            Some(head) if head <= payload.len() => {
                let children = spans(payload, head, payload.len())
                    .and_then(|list| list.iter().map(|c| Atom::from_span(payload, c)).collect::<Result<Vec<_>>>())
                    .map_err(|e| e.context(&format!("{} children", fourcc(&s.kind))))?;
                Ok(Atom::tree(&s.kind, payload[..head].to_vec(), children))
            }
            Some(_) => Err(Error::msg(format!("truncated {} box", fourcc(&s.kind)))),
            None => Ok(Atom::data(&s.kind, payload.to_vec())),
        }
    }

    pub fn size(&self) -> u64 {
        let payload = match &self.body {
            Body::Data(d) => d.len() as u64,
            Body::Tree { head, children } => head.len() as u64 + children.iter().map(Atom::size).sum::<u64>(),
        };
        if payload + 8 > u32::MAX as u64 {
            payload + 16
        } else {
            payload + 8
        }
    }

    pub fn encode(&self, out: &mut Vec<u8>) {
        let size = self.size();
        if size > u32::MAX as u64 {
            out.extend_from_slice(&1u32.to_be_bytes());
            out.extend_from_slice(&self.kind);
            out.extend_from_slice(&size.to_be_bytes());
        } else {
            out.extend_from_slice(&(size as u32).to_be_bytes());
            out.extend_from_slice(&self.kind);
        }
        match &self.body {
            Body::Data(d) => out.extend_from_slice(d),
            Body::Tree { head, children } => {
                out.extend_from_slice(head);
                for c in children {
                    c.encode(out);
                }
            }
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.size() as usize);
        self.encode(&mut out);
        out
    }

    /// Payload of a leaf box.
    pub fn bytes(&self) -> &[u8] {
        match &self.body {
            Body::Data(d) => d,
            Body::Tree { head, .. } => head,
        }
    }

    pub fn bytes_mut(&mut self) -> &mut Vec<u8> {
        match &mut self.body {
            Body::Data(d) => d,
            Body::Tree { head, .. } => head,
        }
    }

    pub fn head(&self) -> &[u8] {
        self.bytes()
    }

    pub fn children(&self) -> &[Atom] {
        match &self.body {
            Body::Tree { children, .. } => children,
            Body::Data(_) => &[],
        }
    }

    pub fn children_mut(&mut self) -> &mut Vec<Atom> {
        match &mut self.body {
            Body::Tree { children, .. } => children,
            Body::Data(_) => panic!("{} is not a container", fourcc(&self.kind)),
        }
    }

    pub fn child(&self, kind: &FourCC) -> Option<&Atom> {
        self.children().iter().find(|c| &c.kind == kind)
    }

    pub fn child_mut(&mut self, kind: &FourCC) -> Option<&mut Atom> {
        match &mut self.body {
            Body::Tree { children, .. } => children.iter_mut().find(|c| &c.kind == kind),
            Body::Data(_) => None,
        }
    }

    pub fn all<'a>(&'a self, kind: &'a FourCC) -> impl Iterator<Item = &'a Atom> + 'a {
        self.children().iter().filter(move |c| &c.kind == kind)
    }

    /// Follows a path of child types.
    pub fn path(&self, path: &[&FourCC]) -> Option<&Atom> {
        path.iter().try_fold(self, |a, k| a.child(k))
    }

    pub fn path_mut(&mut self, path: &[&FourCC]) -> Option<&mut Atom> {
        path.iter().try_fold(self, |a, k| a.child_mut(k))
    }

    pub fn req(&self, path: &[&FourCC]) -> Result<&Atom> {
        self.path(path).ok_or_else(|| missing(path))
    }

    pub fn req_mut(&mut self, path: &[&FourCC]) -> Result<&mut Atom> {
        self.path_mut(path).ok_or_else(|| missing(path))
    }

    pub fn is_tree(&self) -> bool {
        matches!(self.body, Body::Tree { .. })
    }

    /// Full-box version and flags of a leaf.
    pub fn version(&self) -> u8 {
        self.bytes().first().copied().unwrap_or(0)
    }

    pub fn flags(&self) -> u32 {
        let b = self.bytes();
        if b.len() < 4 {
            return 0;
        }
        be32(b, 0) & 0x00ff_ffff
    }
}

fn missing(path: &[&FourCC]) -> Error {
    let names: Vec<String> = path.iter().map(|k| fourcc(k)).collect();
    Error::msg(format!("missing {} box", names.join("/")))
}

/// Checked little helper for reading typed fields from a payload.
pub struct Reader<'a> {
    pub b: &'a [u8],
    pub at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Reader { b, at: 0 }
    }
    pub fn left(&self) -> usize {
        self.b.len().saturating_sub(self.at)
    }
    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.left() < n {
            return Err(Error::new("truncated box payload"));
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    pub fn u16(&mut self) -> Result<u16> {
        Ok(be16(self.take(2)?, 0))
    }
    pub fn u32(&mut self) -> Result<u32> {
        Ok(be32(self.take(4)?, 0))
    }
    pub fn u64(&mut self) -> Result<u64> {
        Ok(be64(self.take(8)?, 0))
    }
}

/// Encodes a full box payload prefix.
pub fn version_flags(version: u8, flags: u32) -> [u8; 4] {
    ((version as u32) << 24 | (flags & 0x00ff_ffff)).to_be_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(kind: &FourCC, payload: &[u8]) -> Vec<u8> {
        let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn round_trips_and_expands_containers() {
        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend(leaf(b"c608", &[0; 16]));
        let mut stbl = leaf(b"stsd", &stsd);
        stbl.extend(leaf(b"stts", &[0; 8]));
        let file = [leaf(b"ftyp", b"isom\0\0\0\0"), leaf(b"moov", &leaf(b"stbl", &stbl))].concat();
        let atoms = parse(&file).unwrap();
        let stsd = atoms[1].req(&[b"stbl", b"stsd"]).unwrap();
        assert_eq!(stsd.head().len(), 8);
        assert_eq!(stsd.children()[0].kind, *b"c608");
        let mut out = Vec::new();
        atoms.iter().for_each(|a| a.encode(&mut out));
        assert_eq!(out, file);
    }

    #[test]
    fn rejects_boxes_past_their_parent() {
        let mut bad = leaf(b"moov", &leaf(b"trak", &[]));
        bad[11] = 40;
        assert!(parse(&bad).is_err());
    }
}
