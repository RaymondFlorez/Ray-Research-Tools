package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/coder/websocket"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
)

// Coinbase is a live adapter for Coinbase Exchange's public websocket feed:
// the `ticker` channel, which needs no key. Each ticker message becomes one
// message in the canonical wire format, on a channel per product, and the hub
// decodes, sequences, conflates and entitles it like any other feed.
//
// The adapter numbers each product's messages as they arrive. Coinbase's own
// `sequence` is the product's, which channels other than `ticker` also
// advance, so it is not contiguous on this channel and would read as a gap on
// almost every message. Gap detection on this feed would need the `full`
// channel, which is not built; a dropped connection shows as staleness and
// ends Run with an error.
type Coinbase struct {
	URL      string
	Products []string
}

func (c Coinbase) Name() string { return "coinbase" }

type coinbaseTicker struct {
	Type      string `json:"type"`
	ProductID string `json:"product_id"`
	Price     string `json:"price"`
	BestBid   string `json:"best_bid"`
	BestAsk   string `json:"best_ask"`
	LastSize  string `json:"last_size"`
	Volume24h string `json:"volume_24h"`
	Time      string `json:"time"`
	Message   string `json:"message"`
	Reason    string `json:"reason"`
}

// CoinbaseTicker translates one feed message into the canonical wire format.
// Messages that are not tickers (the subscription confirmation, heartbeats)
// give ok=false; an `error` message is an error.
func CoinbaseTicker(payload []byte) (wire ingest.Wire, ok bool, err error) {
	var m coinbaseTicker
	if err := json.Unmarshal(payload, &m); err != nil {
		return ingest.Wire{}, false, fmt.Errorf("coinbase: %w", err)
	}
	switch m.Type {
	case "error":
		return ingest.Wire{}, false, fmt.Errorf("coinbase: %s %s", m.Message, m.Reason)
	case "ticker":
	default:
		return ingest.Wire{}, false, nil
	}
	at, err := time.Parse(time.RFC3339Nano, m.Time)
	if err != nil {
		return ingest.Wire{}, false, fmt.Errorf("coinbase %s: time %q", m.ProductID, m.Time)
	}
	fields := map[string]float64{}
	for name, raw := range map[string]string{"price": m.Price, "bid": m.BestBid, "ask": m.BestAsk, "size": m.LastSize, "volume24h": m.Volume24h} {
		if raw == "" {
			continue
		}
		v, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return ingest.Wire{}, false, fmt.Errorf("coinbase %s %s: %q", m.ProductID, name, raw)
		}
		fields[name] = v
	}
	return ingest.Wire{Symbol: m.ProductID, T: float64(at.UnixMilli()), Fields: fields}, true, nil
}

// Run connects, subscribes, and emits until ctx ends or the feed fails.
func (c Coinbase) Run(ctx context.Context, emit func(ingest.Raw) error) error {
	url := c.URL
	if url == "" {
		url = "wss://ws-feed.exchange.coinbase.com"
	}
	if len(c.Products) == 0 {
		return fmt.Errorf("coinbase: no products")
	}
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return fmt.Errorf("coinbase: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	sub, _ := json.Marshal(map[string]any{"type": "subscribe", "product_ids": c.Products, "channels": []string{"ticker"}})
	if err := conn.Write(ctx, websocket.MessageText, sub); err != nil {
		return fmt.Errorf("coinbase subscribe: %w", err)
	}
	seq := map[string]uint64{}
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("coinbase: %w", err)
		}
		wire, ok, err := CoinbaseTicker(payload)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		body, _ := json.Marshal(wire)
		seq[wire.Symbol]++
		n := seq[wire.Symbol]
		if err := emit(ingest.Raw{Feed: c.Name(), Channel: "ticker:" + wire.Symbol, Seq: n, Payload: body, ReceivedAt: time.Now()}); err != nil {
			return err
		}
	}
}
