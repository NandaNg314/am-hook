// Package c608 repairs malformed QuickTime closed-caption (c608) samples in
// place, without changing any sample size or data offset.
//
// Apple MV streams start their caption track with an all-zero 12-byte sample.
// A c608 sample must be a sequence of cdat/cdt2 atoms; recent FFmpeg rejects
// the zero sample and retries it forever, so mpv stops playback after ten
// read errors. Such samples are rewritten as a cdat atom of CEA-608 null pairs.
package c608

import (
	"fmt"

	"github.com/itouakirai/mp4ff/mp4"
)

// nullPair is the CEA-608 padding byte (0x00 with odd parity).
const nullPair = 0x80

// valid applies FFmpeg's c608 sample rules (libavformat/mov.c
// get_eia608_packet): samples of at most 8 bytes are passed through, larger
// ones need at least 10 bytes and consist of atoms carrying whole byte pairs.
// A tail shorter than 10 bytes is ignored.
func valid(b []byte) bool {
	if len(b) <= 8 {
		return true
	}
	if len(b) < 10 {
		return false
	}
	for len(b) >= 10 {
		size := uint64(b[0])<<24 | uint64(b[1])<<16 | uint64(b[2])<<8 | uint64(b[3])
		if size < 10 || size > uint64(len(b)) || size%2 != 0 {
			return false
		}
		b = b[size:]
	}
	return true
}

// repair rewrites b as one cdat atom of null pairs, followed by at most one
// zero byte when the sample size is odd. It reports false when b is too short
// to hold an atom with one byte pair.
func repair(b []byte) bool {
	if len(b) < 10 {
		return false
	}
	size := len(b) &^ 1
	b[0], b[1], b[2], b[3] = byte(size>>24), byte(size>>16), byte(size>>8), byte(size)
	copy(b[4:8], "cdat")
	for i := 8; i < size; i++ {
		b[i] = nullPair
	}
	for i := size; i < len(b); i++ {
		b[i] = 0
	}
	return true
}

// Repair fixes malformed samples of the given caption tracks in frag, whose
// moof and mdat StartPos must be the absolute positions the offsets refer to.
// tracks maps a caption track ID to its trex (nil when absent). It returns the
// number of samples rewritten.
func Repair(frag *mp4.Fragment, tracks map[uint32]*mp4.TrexBox) (int, error) {
	if len(tracks) == 0 || frag.Moof == nil || frag.Mdat == nil {
		return 0, nil
	}
	data := frag.Mdat.Data
	start := frag.Mdat.PayloadAbsoluteOffset()
	repaired := 0
	for _, traf := range frag.Moof.Trafs {
		trex, ok := tracks[traf.Tfhd.TrackID]
		if !ok {
			continue
		}
		base := frag.Moof.StartPos
		if traf.Tfhd.HasBaseDataOffset() {
			base = traf.Tfhd.BaseDataOffset
		}
		size := uint32(0)
		if traf.Tfhd.HasDefaultSampleSize() {
			size = traf.Tfhd.DefaultSampleSize
		} else if trex != nil {
			size = trex.DefaultSampleSize
		}
		// Without a trun data-offset, samples continue after the previous trun.
		offset := base
		for _, trun := range traf.Truns {
			if trun.HasDataOffset() {
				offset = uint64(int64(base) + int64(trun.DataOffset))
			}
			for _, s := range trun.Samples {
				n := size
				if trun.HasSampleSize() {
					n = s.Size
				}
				if offset < start || offset+uint64(n) > start+uint64(len(data)) {
					return repaired, fmt.Errorf("caption track %d sample outside mdat", traf.Tfhd.TrackID)
				}
				b := data[offset-start : offset-start+uint64(n)]
				if !valid(b) && repair(b) {
					repaired++
				}
				offset += uint64(n)
			}
		}
	}
	return repaired, nil
}

// Tracks returns the caption track IDs of init mapped to their trex boxes.
func Tracks(init *mp4.InitSegment) map[uint32]*mp4.TrexBox {
	tracks := map[uint32]*mp4.TrexBox{}
	for _, trak := range init.Moov.Traks {
		if trak.Mdia == nil || trak.Mdia.Minf == nil || trak.Mdia.Minf.Stbl == nil || trak.Mdia.Minf.Stbl.Stsd == nil {
			continue
		}
		for _, entry := range trak.Mdia.Minf.Stbl.Stsd.Children {
			if entry.Type() != "c608" {
				continue
			}
			var trex *mp4.TrexBox
			if init.Moov.Mvex != nil {
				for _, t := range init.Moov.Mvex.Trexs {
					if t.TrackID == trak.Tkhd.TrackID {
						trex = t
					}
				}
			}
			tracks[trak.Tkhd.TrackID] = trex
			break
		}
	}
	return tracks
}
