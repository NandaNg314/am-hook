//go:build js && wasm

// Browser-only PlayReady and fragmented MP4 core. No network or filesystem IO.
package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
	"syscall/js"

	"am-hook/mvcore/defrag"
	pr "git.gay/itouakirai/puppyready"
	"github.com/itouakirai/mp4ff/mp4"
)

type stream struct {
	info mp4.DecryptInfo
	init *mp4.InitSegment
	ids  map[uint32]uint32
	// First decode timestamps are retained across seeks and subtracted from each track.
	origin map[uint32]uint64
}

var streams = map[string]*stream{}
var cdm *pr.CDM

func input(v js.Value) []byte { b := make([]byte, v.Length()); js.CopyBytesToGo(b, v); return b }
func output(b []byte) js.Value {
	v := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(v, b)
	return v
}
func encode(v interface{ Encode(io.Writer) error }) ([]byte, error) {
	var b bytes.Buffer
	err := v.Encode(&b)
	return b.Bytes(), err
}

// syncFile adapts a FileSystemSyncAccessHandle-like object (read/write with
// {at}) to Go IO. Reads are served from a read-ahead window to keep the number
// of JS calls small while lazy mdat parsing issues many tiny reads.
type syncFile struct {
	h         js.Value
	pos, size int64
	buf       []byte
	start     int64
	js        js.Value
}

func newSyncFile(h js.Value) *syncFile {
	return &syncFile{h: h, size: int64(h.Call("getSize").Float())}
}
func (f *syncFile) view(n int) js.Value {
	if f.js.IsUndefined() || f.js.Length() < n {
		f.js = js.Global().Get("Uint8Array").New(n)
	}
	return f.js.Call("subarray", 0, n)
}
func (f *syncFile) Read(p []byte) (int, error) {
	if f.pos >= f.size {
		return 0, io.EOF
	}
	if f.pos < f.start || f.pos >= f.start+int64(len(f.buf)) {
		n := int64(1 << 20)
		if int64(len(p)) > n {
			n = int64(len(p))
		}
		if n > f.size-f.pos {
			n = f.size - f.pos
		}
		v := f.view(int(n))
		got := f.h.Call("read", v, map[string]interface{}{"at": float64(f.pos)}).Int()
		if got <= 0 {
			return 0, io.ErrUnexpectedEOF
		}
		if cap(f.buf) < got {
			f.buf = make([]byte, got)
		}
		f.buf = f.buf[:got]
		js.CopyBytesToGo(f.buf, v.Call("subarray", 0, got))
		f.start = f.pos
	}
	n := copy(p, f.buf[f.pos-f.start:])
	f.pos += int64(n)
	return n, nil
}
func (f *syncFile) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekCurrent:
		offset += f.pos
	case io.SeekEnd:
		offset += f.size
	}
	if offset < 0 {
		return 0, fmt.Errorf("negative seek")
	}
	f.pos = offset
	return offset, nil
}
func (f *syncFile) Write(p []byte) (int, error) {
	v := f.view(len(p))
	js.CopyBytesToJS(v, p)
	if n := f.h.Call("write", v, map[string]interface{}{"at": float64(f.pos)}).Int(); n != len(p) {
		return n, io.ErrShortWrite
	}
	f.pos += int64(len(p))
	return len(p), nil
}

func register(name string, fn func([]js.Value) (interface{}, error)) {
	js.Global().Set(name, js.FuncOf(func(_ js.Value, a []js.Value) (result interface{}) {
		defer func() {
			if r := recover(); r != nil {
				result = map[string]interface{}{"error": fmt.Sprint(r)}
			}
		}()
		v, err := fn(a)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return v
	}))
}
func main() {
	register("mvChallenge", func(a []js.Value) (interface{}, error) {
		if cdm == nil {
			d, e := pr.DefaultDevice()
			if e != nil {
				return nil, e
			}
			cdm = pr.NewCDM(d)
		}
		uri := a[0].String()
		_, payload, ok := strings.Cut(uri, ",")
		if !ok {
			return nil, fmt.Errorf("invalid PlayReady URI")
		}
		var header string
		if p, e := pr.ParsePSSH(payload); e == nil && len(p.WRMHeaders) > 0 {
			header = p.WRMHeaders[0]
		} else {
			b, e := base64.StdEncoding.DecodeString(payload)
			if e != nil || len(b) != 16 {
				return nil, fmt.Errorf("invalid PlayReady PSSH/KID")
			}
			header = `<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0"><DATA><PROTECTINFO><KEYLEN>16</KEYLEN><ALGID>AESCTR</ALGID></PROTECTINFO><KID>` + payload + `</KID></DATA></WRMHEADER>`
			uri = "data:;base64," + payload
		}
		id, e := cdm.Open()
		if e != nil {
			return nil, e
		}
		challenge, e := cdm.GetLicenseChallenge(id, header)
		if e != nil {
			cdm.Close(id)
			return nil, e
		}
		return map[string]interface{}{"session": id, "uri": uri, "challenge": base64.StdEncoding.EncodeToString([]byte(challenge))}, nil
	})
	register("mvLicense", func(a []js.Value) (interface{}, error) {
		id := a[0].String()
		defer cdm.Close(id)
		b, e := base64.StdEncoding.DecodeString(a[1].String())
		if e != nil {
			return nil, e
		}
		if e = cdm.ParseLicense(id, b); e != nil {
			return nil, e
		}
		keys, e := cdm.GetKeys(id)
		if e != nil {
			return nil, e
		}
		if len(keys) != 1 || len(keys[0].Key) != 16 {
			return nil, fmt.Errorf("expected one 128-bit content key, got %d", len(keys))
		}
		return output(keys[0].Key), nil
	})
	register("mvCloseSession", func(a []js.Value) (interface{}, error) {
		if cdm != nil {
			cdm.Close(a[0].String())
		}
		return nil, nil
	})
	register("mvInit", func(a []js.Value) (interface{}, error) {
		f, e := mp4.DecodeFile(bytes.NewReader(input(a[1])))
		if e != nil {
			return nil, e
		}
		if f.Init == nil || f.Init.Moov.Mvex == nil {
			return nil, fmt.Errorf("missing fragmented MP4 init")
		}
		info, e := mp4.DecryptInit(f.Init)
		if e != nil {
			return nil, e
		}
		s := &stream{info: info, init: f.Init, ids: map[uint32]uint32{}, origin: map[uint32]uint64{}}
		base := uint32(a[2].Int())
		for i, t := range f.Init.Moov.Traks {
			s.ids[t.Tkhd.TrackID] = base + uint32(i)
		}
		streams[a[0].String()] = s
		b, e := encode(f.Init)
		return output(b), e
	})
	register("mvFragment", func(a []js.Value) (interface{}, error) {
		s := streams[a[0].String()]
		if s == nil {
			return nil, fmt.Errorf("stream is closed")
		}
		r := bytes.NewReader(input(a[1]))
		key := input(a[2])
		mux := a[3].Bool()
		seq := uint32(a[4].Int())
		if len(key) != 16 {
			return nil, fmt.Errorf("invalid content key")
		}
		var out bytes.Buffer
		var pos uint64
		var frag *mp4.Fragment
		for r.Len() > 0 {
			box, e := mp4.DecodeBox(pos, r)
			if e != nil {
				return nil, e
			}
			start := pos
			pos += box.Size()
			switch b := box.(type) {
			case *mp4.MoofBox:
				if frag != nil {
					return nil, fmt.Errorf("incomplete fragment")
				}
				b.StartPos = start
				frag = mp4.NewFragment()
				frag.StartPos = start
				frag.AddChild(b)
			case *mp4.MdatBox:
				if frag == nil {
					return nil, fmt.Errorf("mdat without moof")
				}
				frag.AddChild(b)
				if e = mp4.DecryptFragment(frag, s.info, key); e != nil && e.Error() != "no senc box in traf" {
					return nil, e
				}
				for _, traf := range frag.Moof.Trafs {
					if traf.Tfdt == nil {
						return nil, fmt.Errorf("fragment has no decode timestamp")
					}
					id := traf.Tfhd.TrackID
					stamp := traf.Tfdt.BaseMediaDecodeTime()
					origin, ok := s.origin[id]
					if !ok {
						origin = stamp
						s.origin[id] = origin
					}
					if stamp < origin {
						return nil, fmt.Errorf("non-monotonic track origin")
					}
					// Keep box size stable: multi-trun fragments preserve their existing
					// relative data offsets, including interleaved caption samples.
					version := traf.Tfdt.Version
					traf.Tfdt.SetBaseMediaDecodeTime(stamp - origin)
					traf.Tfdt.Version = version
				}
				if mux {
					frag.Moof.Mfhd.SequenceNumber = seq
					seq++
					for _, traf := range frag.Moof.Trafs {
						id, ok := s.ids[traf.Tfhd.TrackID]
						if !ok {
							return nil, fmt.Errorf("unknown track")
						}
						traf.Tfhd.TrackID = id
					}
				}
				if e = frag.Encode(&out); e != nil {
					return nil, e
				}
				frag = nil
			}
		}
		if frag != nil || out.Len() == 0 {
			return nil, fmt.Errorf("missing or incomplete media fragment")
		}
		return output(out.Bytes()), nil
	})
	register("mvMuxInit", func(a []js.Value) (interface{}, error) {
		var merged *mp4.InitSegment
		for _, arg := range a[:2] {
			s := streams[arg.String()]
			if s == nil {
				return nil, fmt.Errorf("stream is closed")
			}
			b, e := encode(s.init)
			if e != nil {
				return nil, e
			}
			f, e := mp4.DecodeFile(bytes.NewReader(b))
			if e != nil {
				return nil, e
			}
			for _, t := range f.Init.Moov.Traks {
				t.Tkhd.TrackID = s.ids[t.Tkhd.TrackID]
			}
			for _, t := range f.Init.Moov.Mvex.Trexs {
				t.TrackID = s.ids[t.TrackID]
			}
			if merged == nil {
				merged = f.Init
			} else {
				for _, t := range f.Init.Moov.Traks {
					merged.Moov.AddChild(t)
				}
				for _, t := range f.Init.Moov.Mvex.Trexs {
					merged.Moov.Mvex.AddChild(t)
				}
			}
		}
		duration := a[2].Float()
		mvhd := merged.Moov.Mvhd
		mvhd.Duration = uint64(duration * float64(mvhd.Timescale))
		mvhd.NextTrackID = 1
		for _, t := range merged.Moov.Traks {
			t.Tkhd.Duration = mvhd.Duration
			t.Mdia.Mdhd.Duration = uint64(duration * float64(t.Mdia.Mdhd.Timescale))
			if t.Tkhd.TrackID >= mvhd.NextTrackID {
				mvhd.NextTrackID = t.Tkhd.TrackID + 1
			}
		}
		b, e := encode(merged)
		return output(b), e
	})
	register("mvDefrag", func(a []js.Value) (interface{}, error) {
		out := newSyncFile(a[1])
		if out.size != 0 {
			return nil, fmt.Errorf("defrag output is not empty")
		}
		// Same progressive layout and brands as the reference mv.Mux output.
		e := defrag.DefragmentWithFtyp(newSyncFile(a[0]), out, "isom", 0x200, []string{"isom", "iso4"})
		return float64(out.pos), e
	})
	register("mvRelease", func(a []js.Value) (interface{}, error) { delete(streams, a[0].String()); return nil, nil })
	js.Global().Set("mvCoreReady", true)
	select {}
}
