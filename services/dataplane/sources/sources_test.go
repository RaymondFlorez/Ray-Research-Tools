package sources

// Every payload in this file is SYNTHETIC: written by hand in the shape each
// source documents, for a made-up company, with made-up numbers. They test
// the decoders against that shape, not against anything the sources returned
// — no source is reachable from where these tests were written.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

const companyFactsSample = `{
 "cik": 1, "entityName": "EXAMPLE CORP (synthetic)",
 "facts": {
  "us-gaap": {
   "Revenues": { "label": "Revenues", "units": { "USD": [
    {"start":"2024-01-01","end":"2024-03-31","val":100,"accn":"0000000001-24-000010","fy":2024,"fp":"Q1","form":"10-Q","filed":"2024-05-02"},
    {"start":"2024-04-01","end":"2024-06-30","val":110,"accn":"0000000001-24-000020","fy":2024,"fp":"Q2","form":"10-Q","filed":"2024-08-01"},
    {"start":"2024-01-01","end":"2024-06-30","val":210,"accn":"0000000001-24-000020","fy":2024,"fp":"Q2","form":"10-Q","filed":"2024-08-01"},
    {"start":"2024-04-01","end":"2024-06-30","val":110,"accn":"0000000001-25-000010","fy":2025,"fp":"Q2","form":"10-Q","filed":"2025-07-31"},
    {"start":"2024-01-01","end":"2024-03-31","val":98,"accn":"0000000001-25-000005","fy":2024,"fp":"FY","form":"10-K/A","filed":"2025-03-14"},
    {"start":"2024-01-01","end":"2024-12-31","val":450,"accn":"0000000001-25-000001","fy":2024,"fp":"FY","form":"10-K","filed":"2025-02-20"}
   ]}},
   "Assets": { "label": "Assets", "units": { "USD": [
    {"end":"2024-06-30","val":5000,"accn":"0000000001-24-000020","fy":2024,"fp":"Q2","form":"10-Q","filed":"2024-08-01"}
   ]}}
  }
 }
}`

func TestEDGARVersionsPeriodsAndKnowledgeTimes(t *testing.T) {
	concepts := []Concept{}
	for _, spec := range []string{"revenue=us-gaap:Revenues:USD:3M", "revenue_fy=us-gaap:Revenues:USD:12M", "assets=us-gaap:Assets:USD:I"} {
		c, err := ParseConcept(spec)
		if err != nil {
			t.Fatal(err)
		}
		concepts = append(concepts, c)
	}
	facts, err := CompanyFacts([]byte(companyFactsSample), "EXMP", concepts)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]pit.Fact{}
	for _, f := range facts {
		got[f.Key] = append(got[f.Key], f)
	}
	rev := got["EXMP.revenue"]
	// Q1 as filed, then its restatement; Q2 once — its repetition a year later
	// as a comparative is not a new version; the six-month figure is not a quarter.
	if len(rev) != 3 {
		t.Fatalf("quarterly revenue: %+v", rev)
	}
	if rev[0].ValidTime != "2024-03-31" || rev[0].Value != 100 || rev[0].KnowledgeTime != "2024-05-03T05:00:00Z" || rev[0].Restatement {
		t.Errorf("Q1 as filed: %+v", rev[0])
	}
	if rev[1].Value != 98 || !rev[1].Restatement || rev[1].KnowledgeTime != "2025-03-15T05:00:00Z" || rev[1].Source != "SEC EDGAR 10-K/A 0000000001-25-000005" {
		t.Errorf("Q1 restated: %+v", rev[1])
	}
	if rev[2].ValidTime != "2024-06-30" || rev[2].Value != 110 || rev[2].Restatement {
		t.Errorf("Q2: %+v", rev[2])
	}
	if fy := got["EXMP.revenue_fy"]; len(fy) != 1 || fy[0].Value != 450 || fy[0].ValidTime != "2024-12-31" {
		t.Errorf("fiscal year: %+v", fy)
	}
	if a := got["EXMP.assets"]; len(a) != 1 || a[0].Value != 5000 {
		t.Errorf("instant: %+v", a)
	}
	for _, f := range facts {
		if f.Class != entitle.Public {
			t.Errorf("%s is %s; EDGAR is public", f.Key, f.Class)
		}
	}

	// Through a store: the morning after the 10-Q sees the figure as filed,
	// and the morning the 10-Q was filed does not see it at all.
	store := pit.NewMemory()
	if err := store.Append(context.Background(), facts...); err != nil {
		t.Fatal(err)
	}
	read := func(at string) []pit.Observation {
		obs, err := store.AsOf(context.Background(), pit.Query{Key: "EXMP.revenue", KnowledgeTime: at})
		if err != nil {
			t.Fatal(err)
		}
		return obs
	}
	if obs := read("2024-05-02T13:30:00Z"); len(obs) != 0 {
		t.Errorf("the filing day's morning saw %+v", obs)
	}
	if obs := read("2024-05-03T13:30:00Z"); len(obs) != 1 || obs[0].Value != 100 {
		t.Errorf("the next morning: %+v", obs)
	}
	if obs := read("2025-06-01T00:00:00Z"); len(obs) != 2 || obs[0].Value != 98 {
		t.Errorf("after the restatement: %+v", obs)
	}
}

func TestEDGARRefusesWhatItCannotRead(t *testing.T) {
	for spec, want := range map[string]string{
		"revenue=us-gaap:Revenue:USD:3M":  "has no us-gaap:Revenue",
		"revenue=us-gaap:Revenues:EUR:3M": "is not reported in EUR (it is in USD)",
	} {
		c, err := ParseConcept(spec)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := CompanyFacts([]byte(companyFactsSample), "EXMP", []Concept{c}); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", spec, err, want)
		}
	}
	if _, err := ParseConcept("revenue=us-gaap:Revenues:USD:6M"); err == nil {
		t.Error("a six-month period was accepted")
	}
	if _, err := (EDGAR{Client: http.DefaultClient}).Facts(context.Background(), 1, "EXMP", nil); err == nil || !strings.Contains(err.Error(), "User-Agent") {
		t.Errorf("no User-Agent: %v", err)
	}
}

func TestEDGARFetchSendsTheUserAgentAndResolvesTickers(t *testing.T) {
	var agents []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agents = append(agents, r.Header.Get("User-Agent"))
		switch r.URL.Path {
		case "/files/company_tickers.json":
			_, _ = w.Write([]byte(`{"0":{"cik_str":1,"ticker":"EXMP","title":"EXAMPLE CORP"}}`))
		case "/api/xbrl/companyfacts/CIK0000000001.json":
			_, _ = w.Write([]byte(companyFactsSample))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	e := EDGAR{Client: srv.Client(), UserAgent: "Example Research admin@example.com", DataBase: srv.URL, WWWBase: srv.URL}
	cik, err := e.CIK(context.Background(), "exmp")
	if err != nil || cik != 1 {
		t.Fatalf("cik %d, %v", cik, err)
	}
	c, _ := ParseConcept("assets=us-gaap:Assets:USD:I")
	facts, err := e.Facts(context.Background(), cik, "EXMP", []Concept{c})
	if err != nil || len(facts) != 1 {
		t.Fatalf("%+v, %v", facts, err)
	}
	for _, a := range agents {
		if a != "Example Research admin@example.com" {
			t.Errorf("sent User-Agent %q", a)
		}
	}
	if _, err := e.CIK(context.Background(), "NOPE"); err == nil {
		t.Error("an unknown ticker resolved")
	}
}

// In the column layout Treasury documents, including a tenor added part way
// through the series' history and a blank where it was not yet quoted.
const parCurveSample = "\xef\xbb\xbfDate,1 Mo,2 Mo,3 Mo,4 Mo,6 Mo,1 Yr,2 Yr,10 Yr,30 Yr\n" +
	"08/05/2024,5.49,5.43,5.37,,5.05,4.55,3.88,3.78,4.08\n" +
	"08/02/2024,5.49,5.45,5.38,5.33,5.10,4.61,3.88,3.79,4.11\n"

func TestTreasuryParCurve(t *testing.T) {
	facts, err := TreasuryParCurve([]byte(parCurveSample))
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) != 17 {
		t.Fatalf("%d facts, want 17 (one blank)", len(facts))
	}
	var tenY *pit.Fact
	for i := range facts {
		if facts[i].Key == "UST.par.10Y" && facts[i].ValidTime == "2024-08-05" {
			tenY = &facts[i]
		}
		if facts[i].Key == "UST.par.4M" && facts[i].ValidTime == "2024-08-05" {
			t.Errorf("a blank cell became %+v", facts[i])
		}
	}
	if tenY == nil || tenY.Value != 3.78 || tenY.KnowledgeTime != "2024-08-06T05:00:00Z" {
		t.Errorf("10Y on 2024-08-05: %+v", tenY)
	}
	if _, err := TreasuryParCurve([]byte("Date,3 Mo,10 Year,Coupon\n08/05/2024,5.37,3.78,1\n")); err == nil || !strings.Contains(err.Error(), `"Coupon"`) {
		t.Errorf("an unknown column was not refused: %v", err)
	}
	if facts, err := TreasuryParCurve([]byte("Date,1.5 Month,10 Years\n02/18/2025,4.33,4.55\n")); err != nil || facts[0].Key != "UST.par.1.5M" || facts[1].Key != "UST.par.10Y" {
		t.Errorf("long-form headers: %+v %v", facts, err)
	}
}

// The shape of FRED's series/observations response over the full real-time
// period: each vintage of each date, with "." for a value not yet published.
const alfredSample = `{"realtime_start":"1776-07-04","realtime_end":"9999-12-31","observations":[
 {"realtime_start":"2024-07-25","realtime_end":"2024-08-28","date":"2024-04-01","value":"100.0"},
 {"realtime_start":"2024-08-29","realtime_end":"2024-09-25","date":"2024-04-01","value":"100.5"},
 {"realtime_start":"2024-09-26","realtime_end":"9999-12-31","date":"2024-04-01","value":"100.5"},
 {"realtime_start":"2024-07-25","realtime_end":"2024-10-29","date":"2024-07-01","value":"."},
 {"realtime_start":"2024-10-30","realtime_end":"9999-12-31","date":"2024-07-01","value":"101.2"}
]}`

func TestALFREDKeepsEveryVintageThatChangesTheValue(t *testing.T) {
	facts, err := ALFRED([]byte(alfredSample), "SYNTH", entitle.Public, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) != 3 {
		t.Fatalf("%+v", facts)
	}
	if facts[0].Value != 100 || facts[0].KnowledgeTime != "2024-07-26T05:00:00Z" || facts[0].Restatement {
		t.Errorf("first release: %+v", facts[0])
	}
	if facts[1].Value != 100.5 || !facts[1].Restatement || facts[1].KnowledgeTime != "2024-08-30T05:00:00Z" {
		t.Errorf("revision: %+v", facts[1])
	}
	if facts[2].ValidTime != "2024-07-01" || facts[2].Value != 101.2 || facts[2].Restatement {
		t.Errorf("the quarter first published after a missing vintage: %+v", facts[2])
	}
	if _, err := ALFRED([]byte(alfredSample), "SYNTH", entitle.Licensed, ""); err == nil {
		t.Error("a licensed series with no vendor was accepted")
	}
}

func TestFREDNeverRepeatsItsKeyInAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error_message":"Bad Request."}`, http.StatusBadRequest)
	}))
	defer srv.Close()
	_, err := FRED{Client: srv.Client(), APIKey: "k3y-s3cret", Base: srv.URL}.Vintages(context.Background(), "GDP", entitle.Public, "")
	if err == nil || strings.Contains(err.Error(), "k3y-s3cret") || !strings.Contains(err.Error(), "<key>") {
		t.Errorf("error: %v", err)
	}
	if _, err := (FRED{Client: srv.Client()}).Vintages(context.Background(), "GDP", entitle.Public, ""); err == nil || !strings.Contains(err.Error(), "API key") {
		t.Errorf("no key: %v", err)
	}
}

const stooqSample = "Date,Open,High,Low,Close,Volume\n2024-08-02,103.76,108.72,101.37,107.27,482027500\n2024-08-05,92.06,103.41,90.69,100.45,552842400\n"

func TestStooqDaily(t *testing.T) {
	facts, err := StooqDaily([]byte(stooqSample), "EXMP", entitle.Licensed, "stooq")
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) != 10 {
		t.Fatalf("%d facts", len(facts))
	}
	close := facts[8]
	if close.Key != "price:EXMP" || close.ValidTime != "2024-08-05" || close.Value != 100.45 || close.KnowledgeTime != "2024-08-05T21:00:00Z" || close.Vendor != "stooq" {
		t.Errorf("close: %+v", close)
	}
	if _, err := StooqDaily([]byte("No data"), "EXMP", entitle.Licensed, "stooq"); err == nil {
		t.Error("\"No data\" was read as an empty history")
	}
	if _, err := StooqDaily([]byte("Date,Close\n2024-08-05,1\n"), "EXMP", entitle.Licensed, "stooq"); err == nil {
		t.Error("a different layout was accepted")
	}
}

func TestKnowledgeTimesAreNeverBeforePublication(t *testing.T) {
	for day, want := range map[string]string{"2024-01-15": "2024-01-16T05:00:00Z", "2024-07-15": "2024-07-16T05:00:00Z", "2024-12-31": "2025-01-01T05:00:00Z"} {
		if got, _ := NextDayNewYork(day); got != want {
			t.Errorf("%s: %s, want %s", day, got, want)
		}
	}
	if _, err := NextDayNewYork("08/05/2024"); err == nil {
		t.Error("a non-ISO date was accepted")
	}
}
