package pty

import (
	"bytes"
	"io"
	"strconv"
	"testing"
)

// chunked hands out data in reads of at most n bytes, like ConPTY.
type chunked struct {
	data []byte
	n    int
}

func (c *chunked) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, io.EOF
	}
	k := min(len(p), c.n, len(c.data))
	copy(p, c.data[:k])
	c.data = c.data[k:]
	return k, nil
}

// BenchmarkFlood: `seq 1 100000` through the output pump.
func BenchmarkFlood(b *testing.B) {
	var buf bytes.Buffer
	for i := 1; i <= 100000; i++ {
		buf.WriteString(strconv.Itoa(i))
		buf.WriteString("\r\n")
	}
	for b.Loop() {
		sends := 0
		var g RepaintGuard
		_ = pumpOutput(&chunked{data: buf.Bytes(), n: 8192}, newTermSize(120, 40), func(kind, data string) { sends++ }, &g, true)
		b.ReportMetric(float64(sends), "sends")
	}
}
