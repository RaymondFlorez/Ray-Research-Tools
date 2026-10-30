// Command dataplane runs stream-ingest and data-access in one process for
// development: point-in-time reads over Postgres (or memory), and a live,
// conflated, entitlement-filtered stream fed by a replayed recording or by
// Coinbase Exchange's public ticker feed.
//
//	dataplane -users config/users.json -symbology config/symbology.json \
//	          [-pg postgres://... -schema pit -migrate] [-replay rec.ndjson -speed 1] \
//	          [-coinbase BTC-USD,ETH-USD]
//
// Point-in-time facts from the free sources are loaded by cmd/load. See
// services/dataplane/README.md.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/access"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/audit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/identity"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/server"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/sources"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/stream"
)

type userFile map[string]struct {
	Tenant    string   `json:"tenant"`
	Vendors   []string `json:"vendors"`
	Positions bool     `json:"positions"`
	MNPI      bool     `json:"mnpi"`
	Write     bool     `json:"write,omitempty"`
}

type symbolFile []struct {
	Feed       string `json:"feed"`
	Symbol     string `json:"symbol"`
	ID         string `json:"id"`
	AssetClass string `json:"assetClass"`
	Class      string `json:"class"`
	Vendor     string `json:"vendor,omitempty"`
}

func readJSON(path string, into any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8740", "listen address; loopback by default, since identity is a development stand-in")
	usersPath := flag.String("users", "", "users and their entitlements (JSON)")
	symPath := flag.String("symbology", "", "feed symbols to instruments (JSON)")
	pgURL := flag.String("pg", "", "Postgres URL; memory when empty")
	schema := flag.String("schema", "pit", "Postgres schema")
	migrate := flag.Bool("migrate", false, "create the schema first (as the owning role)")
	auditSchema := flag.String("audit-schema", "audit", "the audit trail's own schema, with -pg")
	replay := flag.String("replay", "", "a recording to replay as the feed (NDJSON)")
	speed := flag.Float64("speed", 1, "replay speed; 0 is as fast as possible")
	coinbase := flag.String("coinbase", "", "Coinbase Exchange products to stream live, comma-separated (each must be in the symbology under feed \"coinbase\")")
	coinbaseURL := flag.String("coinbase-url", "", "the Coinbase feed's websocket URL; the public feed when empty")
	authURL := flag.String("auth-url", "", "picasso-auth's URL: session tokens are verified against the keys it publishes")
	devIdentity := flag.Bool("dev-identity", false, "also accept X-Picasso-User as the caller's name, for development; never on a network")
	staleAfter := flag.Duration("stale-after", 5*time.Second, "a series with no update for this long is stale")
	flag.Parse()

	if *usersPath == "" || *symPath == "" {
		log.Fatal("-users and -symbology are required")
	}
	if *authURL == "" && !*devIdentity {
		log.Fatal("-auth-url is required: callers are identified by picasso-auth's session tokens (or pass -dev-identity, for development)")
	}
	var uf userFile
	if err := readJSON(*usersPath, &uf); err != nil {
		log.Fatalf("users: %v", err)
	}
	users := server.Users{}
	writers := map[string]bool{}
	for id, u := range uf {
		writers[id] = u.Write
		vendors := map[string]bool{}
		for _, v := range u.Vendors {
			vendors[v] = true
		}
		users[id] = entitle.Entitlements{UserID: id, TenantID: u.Tenant, Vendors: vendors, Positions: u.Positions, MNPI: u.MNPI}
	}
	var sf symbolFile
	if err := readJSON(*symPath, &sf); err != nil {
		log.Fatalf("symbology: %v", err)
	}
	sym := ingest.NewSymbology()
	for _, s := range sf {
		if err := sym.Map(s.Feed, s.Symbol, ingest.Instrument{ID: s.ID, AssetClass: s.AssetClass, Class: entitle.Class(s.Class), Vendor: s.Vendor}); err != nil {
			log.Fatalf("symbology: %v", err)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var store pit.Store = pit.NewMemory()
	var trail audit.Store = &audit.Memory{}
	if *pgURL == "" {
		fmt.Fprintln(os.Stderr, "the audit trail is in memory: positions reads are recorded, and the record ends with the process (use -pg)")
	}
	if *pgURL != "" {
		pool, err := pgxpool.New(ctx, *pgURL)
		if err != nil {
			log.Fatal(err)
		}
		defer pool.Close()
		if *migrate {
			if err := pit.Migrate(ctx, pool, *schema); err != nil {
				log.Fatal(err)
			}
		}
		pg, err := pit.NewPostgres(pool, *schema)
		if err != nil {
			log.Fatal(err)
		}
		store = pg
		if *migrate {
			if err := audit.Migrate(ctx, pool, *auditSchema); err != nil {
				log.Fatal(err)
			}
		}
		if trail, err = audit.NewPostgres(pool, *auditSchema); err != nil {
			log.Fatal(err)
		}
	}

	hub := stream.NewHub(sym, *staleAfter)
	feed := "no feed connected"
	if *replay != "" {
		feed = "replay of " + filepath.Base(*replay)
		f, err := os.Open(*replay)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		go func() {
			if err := hub.Run(ctx, stream.Replay{Source: f, Speed: *speed}); err != nil && ctx.Err() == nil {
				log.Printf("replay ended: %v", err)
			}
		}()
	}

	if *coinbase != "" {
		products := strings.Split(*coinbase, ",")
		for _, p := range products {
			if _, ok := sym.Lookup("coinbase", p); !ok {
				log.Fatalf("coinbase product %s is not in the symbology: an unmapped product would be refused on every tick", p)
			}
		}
		if feed == "no feed connected" {
			feed = "Coinbase Exchange ticker"
		} else {
			feed += " and Coinbase Exchange ticker"
		}
		go func() {
			if err := hub.Run(ctx, sources.Coinbase{URL: *coinbaseURL, Products: products}); err != nil && ctx.Err() == nil {
				log.Printf("coinbase feed ended: %v", err)
			}
		}()
	}

	api := &server.Server{Reader: access.Reader{Store: store}, Hub: hub, Users: users, Writers: writers, Feed: feed, DevIdentity: *devIdentity, Audit: trail}
	if *authURL != "" {
		api.Identity = identity.Remote(*authURL)
	}
	srv := &http.Server{Addr: *addr, Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	fmt.Fprintf(os.Stderr, "dataplane listening on http://%s\n", *addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
