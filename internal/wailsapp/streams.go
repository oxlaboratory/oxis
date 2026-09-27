package wailsapp

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
	"unicode/utf8"
)

// Streams carry what arrives over time — a spawned process's output,
// file changes, a streamed HTTP response — from Go to the page.
//
// The page long-polls: PollStreams waits until something is queued and
// returns everything queued so far, with consecutive output of one
// stream merged into one event. Each stream may have streamQueueLimit
// bytes queued; past that its producer waits for the page to catch up,
// so a process printing faster than the page can show it is slowed
// down instead of filling memory. Every stream ends with one "end"
// event.

// StreamEvent is one piece of a stream. Which fields are set depends on
// Type: "stdout"/"stderr" (Data), "change" (Path, Op), "response"
// (Code = HTTP status, Headers), "data" (Data), "error" (Error), and
// "end" (Code = exit code or HTTP status, Error if it failed).
type StreamEvent struct {
	ID      string            `json:"id"`
	Type    string            `json:"type"`
	Data    string            `json:"data,omitempty"`
	Code    int               `json:"code"`
	Path    string            `json:"path,omitempty"`
	Op      string            `json:"op,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Error   string            `json:"error,omitempty"`

	size int // bytes counted against the stream's queue limit
}

const (
	streamQueueLimit = 1 << 20 // bytes queued per stream before its producer waits
	streamPollLimit  = 4 << 20 // bytes returned by one PollStreams call
	streamMaxOpen    = 64
	streamMaxWait    = 30 * time.Second
	streamEventCost  = 64 // what an event costs on top of its Data
)

type hubStream struct {
	cancel context.CancelFunc
	queued int
	closed bool
}

type streamHub struct {
	mu      sync.Mutex
	space   *sync.Cond // a stream's queue shrank, or a stream closed
	queue   []StreamEvent
	streams map[string]*hubStream
	session int
	wake    chan struct{} // something was queued (or the session changed)
}

func newStreamHub() *streamHub {
	h := &streamHub{streams: map[string]*hubStream{}, wake: make(chan struct{}, 1)}
	h.space = sync.NewCond(&h.mu)
	return h
}

// streams is shared by every stream type (process.go, watch.go,
// httpstream.go).
var streams = newStreamHub()

// open registers a stream. Its context is cancelled when the page
// closes the stream, the page reloads or OXIS exits; the producer then
// stops and calls finish.
func (h *streamHub) open(id string) (context.Context, error) {
	if id == "" {
		return nil, errors.New("stream id is empty")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.streams[id]; ok {
		return nil, fmt.Errorf("stream %q is already open", id)
	}
	if len(h.streams) >= streamMaxOpen {
		return nil, fmt.Errorf("%d streams are already open; close some first", streamMaxOpen)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.streams[id] = &hubStream{cancel: cancel}
	return ctx, nil
}

// drop forgets a stream that failed to start, without an "end" event
// (the start call reports the error instead).
func (h *streamHub) drop(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.streams[id]; s != nil {
		s.cancel()
		delete(h.streams, id)
	}
}

// push queues ev, waiting while its stream is over its queue limit. It
// returns false once the stream is closed; the producer should stop
// (or keep draining its source without pushing).
func (h *streamHub) push(ev StreamEvent) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.streams[ev.ID]
	for s != nil && !s.closed && s.queued >= streamQueueLimit {
		h.space.Wait()
		s = h.streams[ev.ID]
	}
	if s == nil || s.closed {
		return false
	}
	h.enqueue(ev, s)
	return true
}

// finish queues the stream's "end" event and forgets the stream.
func (h *streamHub) finish(ev StreamEvent) {
	ev.Type = "end"
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.streams[ev.ID]
	if s == nil {
		return // reset: the page that opened it is gone
	}
	delete(h.streams, ev.ID)
	s.cancel()
	h.enqueue(ev, nil)
	h.space.Broadcast()
}

func (h *streamHub) enqueue(ev StreamEvent, s *hubStream) {
	ev.size = len(ev.Data) + streamEventCost
	if last := len(h.queue) - 1; last >= 0 && mergeable(h.queue[last], ev) {
		h.queue[last].Data += ev.Data
		h.queue[last].size += ev.size
	} else {
		h.queue = append(h.queue, ev)
	}
	if s != nil {
		s.queued += ev.size
	}
	select {
	case h.wake <- struct{}{}:
	default:
	}
}

// mergeable: consecutive output of the same kind from one stream.
func mergeable(a, b StreamEvent) bool {
	return a.ID == b.ID && a.Type == b.Type &&
		(a.Type == "stdout" || a.Type == "stderr" || a.Type == "data") &&
		a.size+len(b.Data) < streamQueueLimit
}

// close stops a stream. false means it had already ended.
func (h *streamHub) close(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.streams[id]
	if s == nil {
		return false
	}
	s.closed = true
	s.cancel()
	h.space.Broadcast()
	return true
}

// reset closes every stream, discards what's queued and starts a new
// session, so a poll left over from before a page reload can't take
// events meant for the reloaded page.
func (h *streamHub) reset() int {
	h.mu.Lock()
	for id, s := range h.streams {
		s.closed = true
		s.cancel()
		delete(h.streams, id)
	}
	h.queue = nil
	h.session++
	session := h.session
	h.space.Broadcast()
	h.mu.Unlock()
	select {
	case h.wake <- struct{}{}:
	default:
	}
	return session
}

// poll waits up to wait for events and returns them (an empty slice on
// timeout, or at once if session is out of date).
func (h *streamHub) poll(session int, wait time.Duration) []StreamEvent {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		h.mu.Lock()
		if session != h.session {
			h.mu.Unlock()
			return []StreamEvent{}
		}
		if len(h.queue) > 0 {
			n, total := 0, 0
			for n < len(h.queue) && (n == 0 || total+h.queue[n].size <= streamPollLimit) {
				total += h.queue[n].size
				n++
			}
			out := make([]StreamEvent, n)
			copy(out, h.queue[:n])
			h.queue = append(h.queue[:0], h.queue[n:]...)
			for _, ev := range out {
				if s := h.streams[ev.ID]; s != nil {
					s.queued -= ev.size
				}
			}
			h.space.Broadcast()
			h.mu.Unlock()
			return out
		}
		h.mu.Unlock()
		select {
		case <-h.wake:
		case <-timer.C:
			return []StreamEvent{}
		}
	}
}

// StreamsReset closes every stream (stopping their processes, watchers
// and requests) and returns the session number for PollStreams. The
// page calls it once when it loads, so nothing a plugin started before
// a reload keeps running unseen.
func (a *App) StreamsReset() int { return streams.reset() }

// PollStreams returns queued stream events, waiting up to waitMs (at
// most 30 s) for the first one.
func (a *App) PollStreams(session int, waitMs int) []StreamEvent {
	wait := time.Duration(waitMs) * time.Millisecond
	if wait <= 0 || wait > streamMaxWait {
		wait = streamMaxWait
	}
	return streams.poll(session, wait)
}

// StreamClose stops a stream: kills the process (and everything it
// started), closes the watcher or cancels the request. Its "end" event
// still arrives. false means it had already ended.
func (a *App) StreamClose(id string) bool { return streams.close(id) }

// utf8Joiner turns a byte stream into strings without cutting a
// multi-byte character in two: an incomplete one at the end of a read
// waits for the rest.
type utf8Joiner struct{ carry []byte }

func (j *utf8Joiner) text(p []byte) string {
	b := append(j.carry, p...)
	cut := len(b)
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax+1; i-- {
		if utf8.RuneStart(b[i]) {
			if !utf8.FullRune(b[i:]) {
				cut = i
			}
			break
		}
	}
	s := string(b[:cut])
	j.carry = append([]byte(nil), b[cut:]...)
	return s
}

// flush returns what's left at the end of the stream.
func (j *utf8Joiner) flush() string {
	s := string(j.carry)
	j.carry = nil
	return s
}
