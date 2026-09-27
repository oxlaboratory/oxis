package wailsapp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"
)

// httpStreamIdle is how long a streamed response may go quiet (no new
// data) before the stream gives up, unless the plugin sets idle.
const httpStreamIdle = 120 * time.Second

// HTTPStreamStart backs oxis.net.stream: the response arrives as it's
// sent — a "response" event (status and headers), then "data" events
// (text, never splitting a character), then "end". That's how AI APIs
// stream an answer as they write it (server-sent events or one JSON
// object per line; pluginAPI.ts parses both). TimeoutSeconds limits the
// wait for the response to start, IdleSeconds a silence after that;
// there's no limit on the total time or size. StreamClose cancels it.
// The plugin's "net" permission is checked before this is called.
func (a *App) HTTPStreamStart(id string, o HTTPRequestOptions) error {
	sctx, err := streams.open(id)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(sctx)
	req, err := newPluginRequest(ctx, o)
	if err != nil {
		cancel()
		streams.drop(id)
		return fmt.Errorf("oxis.net.stream %w", err)
	}
	host := req.URL.Host
	wait := httpTimeout(o.TimeoutSeconds)
	idle := httpStreamIdle
	if o.IdleSeconds > 0 {
		idle = time.Duration(o.IdleSeconds) * time.Second
	}

	go func() {
		defer cancel()
		var timedOut atomic.Bool
		timer := time.AfterFunc(wait, func() { timedOut.Store(true); cancel() })
		defer timer.Stop()
		// failed ends the stream with the reason: closed by the plugin,
		// a timeout (timeoutMsg), or err.
		failed := func(status int, err error, timeoutMsg string) {
			msg := err.Error()
			if sctx.Err() != nil {
				msg = "cancelled"
			} else if timedOut.Load() {
				msg = timeoutMsg
			}
			streams.finish(StreamEvent{ID: id, Code: status, Error: msg})
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			failed(0, fmt.Errorf("couldn't reach %s: %w", host, unwrapURLError(err)),
				fmt.Sprintf("no answer from %s within %s", host, wait))
			return
		}
		defer resp.Body.Close()
		timer.Reset(idle)
		if !streams.push(StreamEvent{ID: id, Type: "response", Code: resp.StatusCode, Headers: responseHeaders(resp)}) {
			failed(resp.StatusCode, errors.New("cancelled"), "")
			return
		}

		var j utf8Joiner
		buf := make([]byte, 32<<10)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				timer.Reset(idle)
				if s := j.text(buf[:n]); s != "" && !streams.push(StreamEvent{ID: id, Type: "data", Data: s}) {
					failed(resp.StatusCode, errors.New("cancelled"), "")
					return
				}
			}
			if err != nil {
				if s := j.flush(); s != "" {
					streams.push(StreamEvent{ID: id, Type: "data", Data: s})
				}
				if errors.Is(err, io.EOF) {
					streams.finish(StreamEvent{ID: id, Code: resp.StatusCode})
					return
				}
				failed(resp.StatusCode, fmt.Errorf("the answer from %s broke off: %w", host, err),
					fmt.Sprintf("%s went quiet for %s", host, idle))
				return
			}
		}
	}()
	return nil
}
