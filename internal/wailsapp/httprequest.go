package wailsapp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HTTPRequestOptions is what oxis.net.request passes in.
type HTTPRequestOptions struct {
	URL            string            `json:"url"`
	Method         string            `json:"method"`
	Headers        map[string]string `json:"headers"`
	Body           string            `json:"body"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
	// IdleSeconds is for HTTPStreamStart: how long the response may go
	// quiet before the stream gives up (default 120).
	IdleSeconds int `json:"idleSeconds"`
}

// HTTPResponse mirrors the fields a fetch Response gives the plugin.
type HTTPResponse struct {
	Status  int               `json:"status"`
	OK      bool              `json:"ok"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers"`
	// MS is how long the request took, sending to the last byte.
	MS float64 `json:"ms"`
}

const (
	httpDefaultTimeout = 60 * time.Second
	httpMaxTimeout     = 10 * time.Minute
	httpMaxBody        = 32 << 20
)

// HTTPRequest backs oxis.net.request in the desktop app. OXIS makes the
// request itself, like curl would, so servers that don't send CORS
// headers (most local and self-hosted APIs) are reachable; a fetch from
// the page can't reach them. The plugin's "net" permission is checked
// before this is called (pluginAPI.ts).
func (a *App) HTTPRequest(o HTTPRequestOptions) (HTTPResponse, error) {
	timeout := httpTimeout(o.TimeoutSeconds)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := newPluginRequest(ctx, o)
	if err != nil {
		return HTTPResponse{}, fmt.Errorf("oxis.net.request %w", err)
	}
	u := req.URL

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return HTTPResponse{}, fmt.Errorf("no answer from %s within %s", u.Host, timeout)
		}
		return HTTPResponse{}, fmt.Errorf("couldn't reach %s: %v", u.Host, unwrapURLError(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, httpMaxBody+1))
	if err != nil {
		return HTTPResponse{}, fmt.Errorf("reading the answer from %s failed: %v", u.Host, err)
	}
	if len(data) > httpMaxBody {
		return HTTPResponse{}, fmt.Errorf("the answer from %s is larger than %d MB", u.Host, httpMaxBody>>20)
	}
	return HTTPResponse{
		Status:  resp.StatusCode,
		OK:      resp.StatusCode >= 200 && resp.StatusCode < 300,
		Body:    string(data),
		Headers: responseHeaders(resp),
		MS:      float64(time.Since(start).Microseconds()) / 1000,
	}, nil
}

// newPluginRequest builds a plugin's request: http(s) only, GET by
// default, with an OXIS User-Agent unless the plugin sets one.
func newPluginRequest(ctx context.Context, o HTTPRequestOptions) (*http.Request, error) {
	u, err := url.Parse(o.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("needs an http:// or https:// URL, got %q", o.URL)
	}
	method := strings.ToUpper(strings.TrimSpace(o.Method))
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if o.Body != "" {
		body = strings.NewReader(o.Body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	for k, v := range o.Headers {
		req.Header.Set(k, v)
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "OXIS")
	}
	return req, nil
}

func httpTimeout(seconds int) time.Duration {
	if seconds > 0 {
		return min(time.Duration(seconds)*time.Second, httpMaxTimeout)
	}
	return httpDefaultTimeout
}

// responseHeaders: lower-case names, repeated headers joined.
func responseHeaders(resp *http.Response) map[string]string {
	headers := make(map[string]string, len(resp.Header))
	for k, v := range resp.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	return headers
}

// unwrapURLError drops net/http's `Post "https://…": ` prefix, which
// repeats the URL the plugin already knows.
func unwrapURLError(err error) error {
	if ue, ok := err.(*url.Error); ok {
		return ue.Err
	}
	return err
}
