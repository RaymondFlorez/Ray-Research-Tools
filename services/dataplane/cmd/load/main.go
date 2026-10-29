// Command load fetches point-in-time facts from a free source and appends
// them to a running data plane, reconciled against what it already holds so
// that loading twice never rewrites the past (sources.Reconcile).
//
//	load -to http://127.0.0.1:8740 -as loader edgar -ticker NVDA \
//	     -concepts revenue=us-gaap:Revenues:USD:3M -user-agent "Example Research admin@example.com"
//	load ... treasury -years 2024,2025
//	load ... fred -series GDP -class public              (FRED_API_KEY in the environment)
//	load ... stooq -symbol nvda.us -instrument NVDA      (licensed to vendor "stooq" by default)
//
// -dry-run prints what would be appended instead of appending it. The user
// named by -as must be a writer, and must be able to read every version
// already held for the keys it loads: a version it may not see cannot be
// reconciled against, and the load is refused rather than guessed.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/sources"
)

const batch = 5000

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	global := flag.NewFlagSet("load", flag.ContinueOnError)
	to := global.String("to", "http://127.0.0.1:8740", "the data plane")
	as := global.String("as", "loader", "the writer to append as")
	dryRun := global.Bool("dry-run", false, "print what would be appended, as JSON lines, and append nothing")
	base := global.String("source-base", "", "the source's base URL, for a mirror or a test; the source's own when empty")
	if err := global.Parse(args); err != nil {
		return err
	}
	if global.NArg() == 0 {
		return fmt.Errorf("which source? edgar, treasury, fred or stooq")
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	facts, err := fetch(ctx, client, *base, global.Arg(0), global.Args()[1:])
	if err != nil {
		return err
	}
	dp := dataPlane{base: strings.TrimRight(*to, "/"), user: *as, client: client}
	held, err := dp.held(ctx, facts)
	if err != nil {
		return err
	}
	appended := sources.Reconcile(held, facts, time.Now().UTC().Format(time.RFC3339))
	fmt.Fprintf(stderr, "%d facts from %s; %d already held; %d to append\n", len(facts), global.Arg(0), len(facts)-len(appended), len(appended))
	if *dryRun {
		enc := json.NewEncoder(stdout)
		for _, f := range appended {
			_ = enc.Encode(f)
		}
		return nil
	}
	for i := 0; i < len(appended); i += batch {
		end := min(i+batch, len(appended))
		if err := dp.append(ctx, appended[i:end]); err != nil {
			return fmt.Errorf("after %d appended: %w", i, err)
		}
	}
	return nil
}

func fetch(ctx context.Context, client *http.Client, base, source string, args []string) ([]pit.Fact, error) {
	fs := flag.NewFlagSet(source, flag.ContinueOnError)
	class := fs.String("class", "", "data class of what is loaded (fred and stooq)")
	vendor := fs.String("vendor", "", "vendor, for a licensed class")
	switch source {
	case "edgar":
		ticker := fs.String("ticker", "", "ticker, resolved to a CIK through the SEC's ticker file")
		cik := fs.Int("cik", 0, "CIK, instead of resolving the ticker")
		concepts := fs.String("concepts", "", "comma-separated field=taxonomy:Name:unit:period")
		agent := fs.String("user-agent", os.Getenv("SEC_USER_AGENT"), "who is asking, as the SEC requires (or SEC_USER_AGENT)")
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if *ticker == "" || *concepts == "" {
			return nil, fmt.Errorf("edgar needs -ticker and -concepts")
		}
		var cs []sources.Concept
		for _, spec := range strings.Split(*concepts, ",") {
			c, err := sources.ParseConcept(spec)
			if err != nil {
				return nil, err
			}
			cs = append(cs, c)
		}
		e := sources.EDGAR{Client: client, UserAgent: *agent, DataBase: base, WWWBase: base}
		id := *cik
		if id == 0 {
			var err error
			if id, err = e.CIK(ctx, *ticker); err != nil {
				return nil, err
			}
		}
		return e.Facts(ctx, id, strings.ToUpper(*ticker), cs)
	case "treasury":
		years := fs.String("years", strconv.Itoa(time.Now().Year()), "comma-separated calendar years")
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		var out []pit.Fact
		for _, y := range strings.Split(*years, ",") {
			year, err := strconv.Atoi(strings.TrimSpace(y))
			if err != nil {
				return nil, fmt.Errorf("year %q", y)
			}
			facts, err := sources.Treasury{Client: client, Base: base}.Year(ctx, year)
			if err != nil {
				return nil, err
			}
			out = append(out, facts...)
		}
		return out, nil
	case "fred":
		series := fs.String("series", "", "FRED series id, e.g. GDP")
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if *series == "" || *class == "" {
			return nil, fmt.Errorf("fred needs -series and -class: many FRED series are third parties' data under their own terms, so the class is not assumed")
		}
		return sources.FRED{Client: client, APIKey: os.Getenv("FRED_API_KEY"), Base: base}.Vintages(ctx, *series, entitle.Class(*class), *vendor)
	case "stooq":
		symbol := fs.String("symbol", "", "Stooq symbol, e.g. nvda.us")
		instrument := fs.String("instrument", "", "the instrument id to load it as, e.g. NVDA")
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if *symbol == "" || *instrument == "" {
			return nil, fmt.Errorf("stooq needs -symbol and -instrument")
		}
		c, v := entitle.Class(*class), *vendor
		if c == "" {
			c, v = entitle.Licensed, "stooq"
		}
		return sources.Stooq{Client: client, Base: base}.Daily(ctx, *symbol, *instrument, c, v)
	}
	return nil, fmt.Errorf("unknown source %q: edgar, treasury, fred or stooq", source)
}

type dataPlane struct {
	base, user string
	client     *http.Client
}

// held reads every version already held for the keys in `facts`.
func (d dataPlane) held(ctx context.Context, facts []pit.Fact) ([]pit.Fact, error) {
	keys := map[string]bool{}
	for _, f := range facts {
		keys[f.Key] = true
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	var out []pit.Fact
	for _, key := range sorted {
		var body struct {
			Versions []struct {
				ValidTime     string  `json:"validTime"`
				KnowledgeTime string  `json:"knowledgeTime"`
				Value         float64 `json:"value"`
			} `json:"versions"`
			Withheld []struct {
				ValidTime     string `json:"validTime"`
				KnowledgeTime string `json:"knowledgeTime"`
			} `json:"withheld"`
		}
		if err := d.do(ctx, http.MethodGet, "/v1/versions?"+url.Values{"key": {key}}.Encode(), nil, &body); err != nil {
			return nil, err
		}
		if len(body.Withheld) > 0 {
			return nil, fmt.Errorf("%s: %d version(s) already held are withheld from %s, so the load cannot be reconciled against them", key, len(body.Withheld), d.user)
		}
		for _, v := range body.Versions {
			out = append(out, pit.Fact{Key: key, ValidTime: v.ValidTime, KnowledgeTime: v.KnowledgeTime, Value: v.Value})
		}
	}
	return out, nil
}

func (d dataPlane) append(ctx context.Context, facts []pit.Fact) error {
	body, err := json.Marshal(facts)
	if err != nil {
		return err
	}
	var res struct {
		Appended int `json:"appended"`
	}
	if err := d.do(ctx, http.MethodPost, "/v1/facts", body, &res); err != nil {
		return err
	}
	if res.Appended != len(facts) {
		return fmt.Errorf("the data plane appended %d of %d", res.Appended, len(facts))
	}
	return nil
}

func (d dataPlane) do(ctx context.Context, method, path string, body []byte, into any) error {
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("X-Picasso-User", d.user)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("data plane %s %s: %s: %s", method, path, res.Status, raw)
	}
	return json.Unmarshal(raw, into)
}
