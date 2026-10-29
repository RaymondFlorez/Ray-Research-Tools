package sources

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

// StooqDaily reads Stooq's daily CSV (Date,Open,High,Low,Close,Volume) into
// facts: the close as `price:<instrument>`, the key the backtester settles
// on, and the rest as `<instrument>.open`, `.high`, `.low`, `.volume`.
//
// Each bar is known at 21:00 UTC on its date (AtCloseNewYork). Stooq keeps no
// vintages, so a later correction overwrites the series at the source and
// arrives here as a restatement only if it is loaded again.
//
// Stooq publishes no licence for its data, and does not document whether or
// how its series are adjusted for splits and dividends; the facts are
// licensed to vendor "stooq" unless the caller decides otherwise, and are not
// to be mixed with `adjustments.ts`' corporate actions until that is known.
func StooqDaily(body []byte, instrument string, class entitle.Class, vendor string) ([]pit.Fact, error) {
	if !class.Valid() || (class == entitle.Licensed && vendor == "") {
		return nil, fmt.Errorf("stooq %s: a class, and a vendor if licensed, are required", instrument)
	}
	text := strings.TrimSpace(string(body))
	if text == "" || strings.EqualFold(text, "No data") {
		return nil, fmt.Errorf("stooq has no data for %s", instrument)
	}
	rows, err := csv.NewReader(strings.NewReader(text)).ReadAll()
	if err != nil {
		return nil, fmt.Errorf("stooq %s: %w", instrument, err)
	}
	want := []string{"Date", "Open", "High", "Low", "Close", "Volume"}
	if len(rows[0]) < 5 {
		return nil, fmt.Errorf("stooq %s: header %v", instrument, rows[0])
	}
	for i, h := range rows[0] {
		if i >= len(want) || h != want[i] {
			return nil, fmt.Errorf("stooq %s: header %v, want %v", instrument, rows[0], want)
		}
	}
	keys := []string{"", instrument + ".open", instrument + ".high", instrument + ".low", "price:" + instrument, instrument + ".volume"}
	var out []pit.Fact
	for n, row := range rows[1:] {
		known, err := AtCloseNewYork(row[0])
		if err != nil {
			return nil, fmt.Errorf("stooq %s row %d: %w", instrument, n+2, err)
		}
		for i := 1; i < len(row); i++ {
			v, err := strconv.ParseFloat(row[i], 64)
			if err != nil {
				return nil, fmt.Errorf("stooq %s row %d %s: %q", instrument, n+2, rows[0][i], row[i])
			}
			out = append(out, pit.Fact{
				Key: keys[i], ValidTime: row[0], KnowledgeTime: known, Value: v,
				Source: "Stooq daily", Class: class, Vendor: vendor,
			})
		}
	}
	return out, nil
}

// Stooq fetches a symbol's daily history, e.g. "nvda.us".
type Stooq struct {
	Client *http.Client
	Base   string
}

func (s Stooq) Daily(ctx context.Context, symbol, instrument string, class entitle.Class, vendor string) ([]pit.Fact, error) {
	base := s.Base
	if base == "" {
		base = "https://stooq.com"
	}
	body, err := get(ctx, s.Client, base+"/q/d/l/?"+url.Values{"s": {symbol}, "i": {"d"}}.Encode(), nil)
	if err != nil {
		return nil, err
	}
	return StooqDaily(body, instrument, class, vendor)
}
