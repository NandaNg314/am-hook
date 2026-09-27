package defrag

import (
	"bytes"
	"sort"
	"testing"

	"github.com/itouakirai/mp4ff/aac"
	"github.com/itouakirai/mp4ff/mp4"
)

// testTrack describes one AAC track of the synthetic input: samples of
// sampleDur ticks, grouped into fragments of perFragment samples.
type testTrack struct {
	id          uint32
	timescale   uint32
	sampleDur   uint32
	samples     int
	perFragment int
}

// sampleData is unique per track and sample so misplaced bytes are detected.
func sampleData(track uint32, i int) []byte {
	return bytes.Repeat([]byte{byte(track), byte(i), byte(i >> 8)}, 10+i%7)
}

// fragmented builds a fragmented MP4 in which all fragments of one track
// precede those of the next, i.e. the worst possible source layout.
func fragmented(t *testing.T, tracks []testTrack) []byte {
	t.Helper()
	init := mp4.CreateEmptyInit()
	for _, tr := range tracks {
		init.AddEmptyTrack(tr.timescale, "audio", "und")
		trak := init.Moov.Traks[len(init.Moov.Traks)-1]
		trak.Tkhd.TrackID = tr.id
		init.Moov.Mvex.Trexs[len(init.Moov.Mvex.Trexs)-1].TrackID = tr.id
		if err := trak.SetAACDescriptor(aac.AAClc, int(tr.timescale)); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := init.Encode(&buf); err != nil {
		t.Fatal(err)
	}
	seq := uint32(1)
	for _, tr := range tracks {
		for first := 0; first < tr.samples; first += tr.perFragment {
			frag, err := mp4.CreateFragment(seq, tr.id)
			if err != nil {
				t.Fatal(err)
			}
			seq++
			for i := first; i < first+tr.perFragment && i < tr.samples; i++ {
				data := sampleData(tr.id, i)
				frag.AddFullSample(mp4.FullSample{
					Sample:     mp4.Sample{Flags: mp4.SyncSampleFlags, Size: uint32(len(data)), Dur: tr.sampleDur},
					DecodeTime: uint64(i) * uint64(tr.sampleDur),
					Data:       data,
				})
			}
			if err := frag.Encode(&buf); err != nil {
				t.Fatal(err)
			}
		}
	}
	return buf.Bytes()
}

type outChunk struct {
	offset uint64
	time   float64 // seconds
}

func TestDefragmentInterleavesTracksByTime(t *testing.T) {
	tracks := []testTrack{
		// 0.25 s samples in 6 s fragments.
		{id: 1, timescale: 48000, sampleDur: 12000, samples: 80, perFragment: 24},
		// ~0.1 s samples in 4 s fragments, another timescale.
		{id: 2, timescale: 44100, sampleDur: 4410, samples: 200, perFragment: 40},
	}
	in := fragmented(t, tracks)

	var out bytes.Buffer
	if err := DefragmentWithFtyp(bytes.NewReader(in), &out, "isom", 0x200, []string{"isom", "iso4"}); err != nil {
		t.Fatal(err)
	}
	f, err := mp4.DecodeFile(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if f.IsFragmented() {
		t.Fatal("output is still fragmented")
	}
	data := out.Bytes()

	var chunks []outChunk
	for ti, tr := range tracks {
		trak := f.Moov.Traks[ti]
		stbl := trak.Mdia.Minf.Stbl
		if trak.Tkhd.TrackID != tr.id || stbl.Stco == nil {
			t.Fatalf("track %d: unexpected trak", tr.id)
		}
		sample := 0
		for c, offset := range stbl.Stco.ChunkOffset {
			chunk := stbl.Stsc.GetChunk(uint32(c + 1))
			if int(chunk.StartSampleNr) != sample+1 {
				t.Fatalf("track %d chunk %d starts at sample %d, want %d", tr.id, c, chunk.StartSampleNr, sample+1)
			}
			count := int(chunk.NrSamples)
			chunkDur := float64(count) * float64(tr.sampleDur) / float64(tr.timescale)
			if chunkDur > maxChunkDuration+float64(tr.sampleDur)/float64(tr.timescale) {
				t.Fatalf("track %d chunk %d lasts %.2fs", tr.id, c, chunkDur)
			}
			chunks = append(chunks, outChunk{uint64(offset), float64(sample) * float64(tr.sampleDur) / float64(tr.timescale)})
			p := uint64(offset)
			for i := 0; i < count; i++ {
				want := sampleData(tr.id, sample)
				if size := stbl.Stsz.GetSampleSize(sample + 1); size != uint32(len(want)) {
					t.Fatalf("track %d sample %d size %d, want %d", tr.id, sample, size, len(want))
				}
				if !bytes.Equal(data[p:p+uint64(len(want))], want) {
					t.Fatalf("track %d sample %d has wrong data", tr.id, sample)
				}
				p += uint64(len(want))
				sample++
			}
		}
		if sample != tr.samples {
			t.Fatalf("track %d has %d samples, want %d", tr.id, sample, tr.samples)
		}
	}

	// In file order, chunk start times never go back.
	sort.Slice(chunks, func(i, j int) bool { return chunks[i].offset < chunks[j].offset })
	for i := 1; i < len(chunks); i++ {
		if chunks[i].time < chunks[i-1].time {
			t.Fatalf("chunk at %d starts at %.3fs after one starting at %.3fs", chunks[i].offset, chunks[i].time, chunks[i-1].time)
		}
	}
}

func TestWriteOrderComparesAcrossTimescales(t *testing.T) {
	tracks := []*trackData{
		{Timescale: 1000, Chunks: []outputChunk{{Time: 0}, {Time: 1000}, {Time: 2000}}},
		{Timescale: 3, Chunks: []outputChunk{{Time: 0}, {Time: 2}, {Time: 3}, {Time: 7}}},
	}
	got := writeOrder(tracks)
	want := []chunkRef{{0, 0}, {1, 0}, {1, 1}, {0, 1}, {1, 2}, {0, 2}, {1, 3}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
