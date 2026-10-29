// Package sources is the free market data this data plane can load: decoders
// from each source's published format into point-in-time facts, and the
// connections that fetch them.
//
//   - SEC EDGAR (fundamentals): the XBRL company-facts API. Public domain, no
//     key; the SEC requires a User-Agent naming who is asking.
//   - US Treasury (rates): the daily par yield curve. Public domain, no key.
//   - FRED / ALFRED (macro): series observations with every vintage, so a
//     revision is a later version, not an overwrite. A free API key.
//   - Stooq (daily bars): no key, and no published licence; loaded as licensed.
//   - Coinbase Exchange (live crypto ticks): the public websocket, no key.
//
// One rule is enforced for every source here: **a fact is never stamped as
// known before it was public.** Most of these sources date what they publish
// without a time — EDGAR's filing date, ALFRED's vintage date, Treasury's curve
// date. A filing dated the 28th might have gone out at 16:05 that afternoon,
// and stamping it as known from midnight would let a canvas scrubbed to 09:30
// on the 28th read it. So a fact dated without a time is known from the start
// of the next day in New York (`NextDayNewYork`): late by up to a day, never
// early. A daily close is known at 21:00 UTC on its date, which is at or after
// the 16:00 New York close in both winter and summer time.
package sources

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

// NextDayNewYork is the knowledge time for something dated `day` with no
// time: 05:00 UTC the next day, which is midnight in New York in winter and
// 01:00 in summer — after anything published on `day`, in either.
func NextDayNewYork(day string) (string, error) {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return "", fmt.Errorf("not a date: %q", day)
	}
	return t.AddDate(0, 0, 1).Format("2006-01-02") + "T05:00:00Z", nil
}

// AtCloseNewYork is the knowledge time for a daily close on `day`: 21:00 UTC,
// at or after 16:00 New York time whether or not summer time is in force.
func AtCloseNewYork(day string) (string, error) {
	if _, err := time.Parse("2006-01-02", day); err != nil {
		return "", fmt.Errorf("not a date: %q", day)
	}
	return day + "T21:00:00Z", nil
}

// maxBody bounds what a fetch will read. It is a guard against a runaway
// response, set well above any file these sources are expected to return; it
// is not a measured size.
const maxBody = 256 << 20

// get fetches a URL with the given headers and returns the body, or an error
// naming the status. A non-2xx answer is an error, never an empty dataset.
func get(ctx context.Context, client *http.Client, url string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxBody {
		return nil, fmt.Errorf("%s: response larger than %d bytes", url, maxBody)
	}
	if res.StatusCode/100 != 2 {
		snippet := body
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return nil, fmt.Errorf("%s: %s: %s", url, res.Status, snippet)
	}
	return body, nil
}
