package c608

import (
	"bytes"
	"testing"

	"github.com/itouakirai/mp4ff/mp4"
)

func cdat(pairs ...byte) []byte {
	n := 8 + len(pairs)
	return append([]byte{0, 0, 0, byte(n), 'c', 'd', 'a', 't'}, pairs...)
}

// fragment encodes one video and one caption sample per call like an Apple MV
// segment (both trafs in one moof) and decodes it back with absolute offsets.
func fragment(t *testing.T, prefix int, captions ...[]byte) *mp4.Fragment {
	t.Helper()
	f, err := mp4.CreateMultiTrackFragment(1, []uint32{1, 2})
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range captions {
		video := mp4.FullSample{Sample: mp4.Sample{Size: 5, Dur: 1}, DecodeTime: uint64(i), Data: []byte("video")}
		caption := mp4.FullSample{Sample: mp4.Sample{Size: uint32(len(c)), Dur: 1}, DecodeTime: uint64(i), Data: c}
		if err := f.AddFullSampleToTrack(video, 1); err != nil {
			t.Fatal(err)
		}
		if err := f.AddFullSampleToTrack(caption, 2); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	buf.Write(make([]byte, prefix))
	if err := f.Encode(&buf); err != nil {
		t.Fatal(err)
	}
	r := bytes.NewReader(buf.Bytes()[prefix:])
	out := mp4.NewFragment()
	for pos := uint64(prefix); r.Len() > 0; {
		box, err := mp4.DecodeBox(pos, r)
		if err != nil {
			t.Fatal(err)
		}
		if moof, ok := box.(*mp4.MoofBox); ok {
			moof.StartPos = pos
		}
		out.AddChild(box)
		pos += box.Size()
	}
	return out
}

func TestRepairRewritesOnlyMalformedCaptionSamples(t *testing.T) {
	good := cdat(0x94, 0x20, 0xc1, 0xc2)
	odd := make([]byte, 13)
	frag := fragment(t, 100, make([]byte, 12), good, odd, []byte{1, 2, 3, 4, 5, 6, 7, 8})

	n, err := Repair(frag, map[uint32]*mp4.TrexBox{2: nil})
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("repaired %d samples, want 2", n)
	}
	// Video and caption samples interleave, so every caption trun has its own offset.
	want := bytes.Join([][]byte{
		[]byte("video"), cdat(0x80, 0x80, 0x80, 0x80),
		[]byte("video"), good,
		[]byte("video"), append(cdat(0x80, 0x80, 0x80, 0x80), 0),
		[]byte("video"), {1, 2, 3, 4, 5, 6, 7, 8},
	}, nil)
	if !bytes.Equal(frag.Mdat.Data, want) {
		t.Fatalf("mdat\n got %x\nwant %x", frag.Mdat.Data, want)
	}
}

func TestRepairIgnoresOtherTracks(t *testing.T) {
	frag := fragment(t, 0, make([]byte, 12))
	before := append([]byte(nil), frag.Mdat.Data...)
	if n, err := Repair(frag, map[uint32]*mp4.TrexBox{3: nil}); err != nil || n != 0 {
		t.Fatalf("Repair = %d, %v", n, err)
	}
	if !bytes.Equal(before, frag.Mdat.Data) {
		t.Fatal("mdat changed")
	}
}

func TestValid(t *testing.T) {
	for _, c := range []struct {
		b    []byte
		want bool
	}{
		{make([]byte, 8), true},
		{make([]byte, 9), false},
		{make([]byte, 12), false},
		{cdat(1, 2), true},
		{cdat(1, 2, 3), false},
		{append(cdat(1, 2), cdat(3, 4)...), true},
		{append(cdat(1, 2), 0, 0, 0), true},
	} {
		if got := valid(c.b); got != c.want {
			t.Errorf("valid(%x) = %v, want %v", c.b, got, c.want)
		}
	}
}
