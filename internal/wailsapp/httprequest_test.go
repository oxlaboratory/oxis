package wailsapp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("X-Echo-Auth", r.Header.Get("Authorization"))
		w.WriteHeader(201)
		_, _ = w.Write([]byte(r.Method + " " + string(b)))
	}))
	defer srv.Close()

	a := &App{}
	got, err := a.HTTPRequest(HTTPRequestOptions{
		URL: srv.URL + "/v1/x", Method: "post",
		Headers: map[string]string{"Authorization": "Bearer k"},
		Body:    `{"a":"é \t"}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != 201 || !got.OK || got.Body != `POST {"a":"é \t"}` || got.Headers["x-echo-auth"] != "Bearer k" {
		t.Errorf("got %+v", got)
	}

	for _, bad := range []string{"file:///etc/passwd", "ftp://x", "not a url", ""} {
		if _, err := a.HTTPRequest(HTTPRequestOptions{URL: bad}); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
	if _, err := a.HTTPRequest(HTTPRequestOptions{URL: "http://127.0.0.1:1/"}); err == nil || !strings.Contains(err.Error(), "couldn't reach") {
		t.Errorf("unreachable host: %v", err)
	}
}
