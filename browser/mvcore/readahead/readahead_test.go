package readahead

import (
	"bytes"
	"io"
	"math/rand"
	"testing"
)

type source struct {
	data         []byte
	calls, bytes int
	last         []int // sizes of reads issued
}

func (s *source) readAt(p []byte, at int64) int {
	n := copy(p, s.data[at:])
	s.calls++
	s.bytes += n
	s.last = append(s.last, len(p))
	return n
}

func newSource(n int) *source {
	data := make([]byte, n)
	rand.New(rand.NewSource(1)).Read(data)
	return &source{data: data}
}

func TestMatchesBytesReader(t *testing.T) {
	src := newSource(5<<20 + 123)
	r := New(src.readAt, int64(len(src.data)))
	want := bytes.NewReader(src.data)
	rng := rand.New(rand.NewSource(2))
	for i := 0; i < 2000; i++ {
		if rng.Intn(4) == 0 {
			off := rng.Int63n(int64(len(src.data)) + 10)
			a, errA := r.Seek(off, io.SeekStart)
			b, errB := want.Seek(off, io.SeekStart)
			if a != b || (errA == nil) != (errB == nil) {
				t.Fatalf("seek %d: %d,%v vs %d,%v", off, a, errA, b, errB)
			}
		}
		size := []int{1, 8, 300, MinRead - 1, MinRead, 3 << 20}[rng.Intn(6)]
		got, want2 := make([]byte, size), make([]byte, size)
		n, err := io.ReadFull(r, got)
		m, err2 := io.ReadFull(want, want2)
		if n != m || !bytes.Equal(got[:n], want2[:m]) || (err == nil) != (err2 == nil) {
			t.Fatalf("read %d: got %d,%v want %d,%v", size, n, err, m, err2)
		}
	}
}

func TestLargeReadAfterJumpReadsOnlyRequest(t *testing.T) {
	src := newSource(8 << 20)
	r := New(src.readAt, int64(len(src.data)))
	r.Seek(3<<20+17, io.SeekStart)
	p := make([]byte, 200<<10)
	if _, err := io.ReadFull(r, p); err != nil {
		t.Fatal(err)
	}
	if src.calls != 1 || src.bytes != len(p) {
		t.Fatalf("%d calls, %d bytes; want 1 call of %d bytes", src.calls, src.bytes, len(p))
	}
	if !bytes.Equal(p, src.data[3<<20+17:][:len(p)]) {
		t.Fatal("wrong data")
	}
}

func TestSmallReadsUseReadAhead(t *testing.T) {
	src := newSource(8 << 20)
	r := New(src.readAt, int64(len(src.data)))
	r.Seek(1<<20, io.SeekStart)
	hdr := make([]byte, 8)
	// A jump: a small read fetches MinRead, and following small reads hit it.
	for i := 0; i < MinRead/8; i++ {
		io.ReadFull(r, hdr)
	}
	if src.calls != 1 || src.last[0] != MinRead {
		t.Fatalf("reads %v, want one of %d", src.last, MinRead)
	}
	// Continuing sequentially past the window uses the full Window.
	io.ReadFull(r, hdr)
	if src.calls != 2 || src.last[1] != Window {
		t.Fatalf("reads %v, want a %d window second", src.last, Window)
	}
}

func TestReadAheadStopsAtEnd(t *testing.T) {
	src := newSource(1000)
	r := New(src.readAt, 1000)
	r.Seek(990, io.SeekStart)
	b, err := io.ReadAll(r)
	if err != nil || !bytes.Equal(b, src.data[990:]) {
		t.Fatalf("ReadAll = %d bytes, %v", len(b), err)
	}
	if src.bytes != 10 {
		t.Fatalf("read %d bytes past a 10-byte tail", src.bytes)
	}
}
