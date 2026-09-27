// Package readahead turns a positional reader (such as an OPFS
// FileSystemSyncAccessHandle) into an io.ReadSeeker that keeps the number of
// underlying reads small without reading data nobody asked for.
//
// Lazy MP4 parsing issues many tiny reads (box headers, moof bodies), which
// are served from a read-ahead window. Large reads, such as sample data copied
// chunk by chunk, are passed through at exactly the requested size: after a
// jump to another track's chunk nothing beyond it is read.
package readahead

import (
	"fmt"
	"io"
)

const (
	// Window is the read-ahead size for small reads that continue right
	// after the current window, i.e. sequential parsing.
	Window = 1 << 20
	// MinRead is the read-ahead size for small reads after a jump, and the
	// request size from which reads bypass read-ahead.
	MinRead = 64 << 10
)

// Reader implements io.ReadSeeker over src, which reads into p at absolute
// offset at and returns the number of bytes read (<= 0 on failure).
type Reader struct {
	src       func(p []byte, at int64) int
	pos, size int64
	buf       []byte // buffered data of [start, start+len(buf))
	start     int64
}

// New returns a Reader for a source of the given size.
func New(src func(p []byte, at int64) int, size int64) *Reader {
	return &Reader{src: src, size: size}
}

// Size returns the source size.
func (r *Reader) Size() int64 { return r.size }

func (r *Reader) Read(p []byte) (int, error) {
	if r.pos >= r.size {
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}
	if r.pos >= r.start && r.pos < r.start+int64(len(r.buf)) {
		n := copy(p, r.buf[r.pos-r.start:])
		r.pos += int64(n)
		return n, nil
	}
	if len(p) >= MinRead {
		// Large read: exactly what was requested, straight into p.
		want := int64(len(p))
		if want > r.size-r.pos {
			want = r.size - r.pos
		}
		got := r.src(p[:want], r.pos)
		if got <= 0 {
			return 0, io.ErrUnexpectedEOF
		}
		r.pos += int64(got)
		return got, nil
	}
	n := int64(MinRead)
	if len(r.buf) > 0 && r.pos == r.start+int64(len(r.buf)) {
		n = Window
	}
	if n > r.size-r.pos {
		n = r.size - r.pos
	}
	if int64(cap(r.buf)) < n {
		r.buf = make([]byte, n)
	}
	got := r.src(r.buf[:n], r.pos)
	if got <= 0 {
		r.buf = r.buf[:0]
		return 0, io.ErrUnexpectedEOF
	}
	r.buf, r.start = r.buf[:got], r.pos
	c := copy(p, r.buf)
	r.pos += int64(c)
	return c, nil
}

func (r *Reader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekCurrent:
		offset += r.pos
	case io.SeekEnd:
		offset += r.size
	}
	if offset < 0 {
		return 0, fmt.Errorf("negative seek")
	}
	r.pos = offset
	return offset, nil
}
