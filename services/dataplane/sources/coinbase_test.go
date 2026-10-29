package sources

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
)

// A local server speaking the feed's documented message shapes. SYNTHETIC
// prices; Coinbase is not reachable from where this was written.
func coinbaseStandIn(t *testing.T, messages []string, gotSubscribe chan<- map[string]any) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		_, sub, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		var m map[string]any
		_ = json.Unmarshal(sub, &m)
		gotSubscribe <- m
		for _, msg := range messages {
			if err := conn.Write(r.Context(), websocket.MessageText, []byte(msg)); err != nil {
				return
			}
		}
		conn.Close(websocket.StatusNormalClosure, "done")
	}))
}

func TestCoinbaseTickersBecomeCanonicalEventsOnAChannelPerProduct(t *testing.T) {
	subscribed := make(chan map[string]any, 1)
	srv := coinbaseStandIn(t, []string{
		`{"type":"subscriptions","channels":[{"name":"ticker","product_ids":["BTC-USD","ETH-USD"]}]}`,
		`{"type":"ticker","sequence":9001,"product_id":"BTC-USD","price":"64000.01","best_bid":"64000.00","best_ask":"64000.02","last_size":"0.01","volume_24h":"1234.5","time":"2024-08-05T13:30:00.123456Z"}`,
		`{"type":"heartbeat","sequence":9002,"product_id":"BTC-USD","time":"2024-08-05T13:30:00.5Z"}`,
		`{"type":"ticker","sequence":12,"product_id":"ETH-USD","price":"2500.5","time":"2024-08-05T13:30:01Z"}`,
		`{"type":"ticker","sequence":9050,"product_id":"BTC-USD","price":"64001","time":"2024-08-05T13:30:02Z"}`,
	}, subscribed)
	defer srv.Close()

	var raws []ingest.Raw
	err := Coinbase{URL: "ws" + strings.TrimPrefix(srv.URL, "http"), Products: []string{"BTC-USD", "ETH-USD"}}.Run(context.Background(), func(r ingest.Raw) error {
		raws = append(raws, r)
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "coinbase") {
		t.Errorf("a closed feed should end Run with an error, got %v", err)
	}
	sub := <-subscribed
	if sub["type"] != "subscribe" || len(sub["product_ids"].([]any)) != 2 || sub["channels"].([]any)[0] != "ticker" {
		t.Errorf("subscription: %v", sub)
	}
	if len(raws) != 3 {
		t.Fatalf("%d messages emitted, want the three tickers", len(raws))
	}
	// Coinbase's sequence jumps 9001 → 9050 on the ticker channel; the
	// adapter's numbering does not, so the hub sees no gap.
	if raws[0].Channel != "ticker:BTC-USD" || raws[0].Seq != 1 || raws[2].Channel != "ticker:BTC-USD" || raws[2].Seq != 2 || raws[1].Seq != 1 {
		t.Errorf("channels and numbering: %+v", raws)
	}

	sym := ingest.NewSymbology()
	if err := sym.Map("coinbase", "BTC-USD", ingest.Instrument{ID: "BTC-USD", AssetClass: "crypto", Class: entitle.Public}); err != nil {
		t.Fatal(err)
	}
	ev, rej := ingest.Decode(sym, raws[0])
	if rej != nil {
		t.Fatal(rej.Reason)
	}
	want := float64(time.Date(2024, 8, 5, 13, 30, 0, 123_000_000, time.UTC).UnixMilli())
	if ev.Instrument != "BTC-USD" || ev.Fields["price"] != 64000.01 || ev.Fields["bid"] != 64000 || ev.Fields["ask"] != 64000.02 || ev.ExchangeTime != want {
		t.Errorf("event: %+v", ev)
	}
	if _, rej := ingest.Decode(sym, raws[1]); rej == nil || !strings.Contains(rej.Reason, "unknown symbol ETH-USD") {
		t.Errorf("an unmapped product was not refused: %+v", rej)
	}
}

func TestCoinbaseErrorMessageEndsTheRun(t *testing.T) {
	subscribed := make(chan map[string]any, 1)
	srv := coinbaseStandIn(t, []string{`{"type":"error","message":"Failed to subscribe","reason":"BTC-XYZ is not a valid product"}`}, subscribed)
	defer srv.Close()
	err := Coinbase{URL: "ws" + strings.TrimPrefix(srv.URL, "http"), Products: []string{"BTC-XYZ"}}.Run(context.Background(), func(ingest.Raw) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "BTC-XYZ is not a valid product") {
		t.Errorf("error: %v", err)
	}
}
