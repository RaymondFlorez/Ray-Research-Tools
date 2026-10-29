// Command gateway runs the model gateway: every configured provider behind one
// API, each user calling on their own account.
//
//	GATEWAY_VAULT_KEY=$(openssl rand -base64 32) gateway \
//	    -providers config/providers.json -users ../dataplane/config/users.json \
//	    -vault /var/lib/picasso/vault.json \
//	    -public-url http://127.0.0.1:8750 -return-url http://127.0.0.1:5173/models.html
//
// -ephemeral seals under a random key in memory instead, for development:
// every connection is lost when it stops. See services/gateway/README.md.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/gateway/accounts"
	"github.com/raymondflorez/ray-research-tools/services/gateway/server"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8750", "listen address; loopback by default, since identity is a development stand-in")
	providersPath := flag.String("providers", "", "the providers (JSON)")
	usersPath := flag.String("users", "", "the users (the data plane's users file)")
	vaultPath := flag.String("vault", "", "where sealed credentials are kept")
	ephemeral := flag.Bool("ephemeral", false, "seal under a random key, in memory: connections are lost on exit")
	publicURL := flag.String("public-url", "", "where the browser reaches this gateway (for sign-in callbacks)")
	returnURL := flag.String("return-url", "", "where a finished sign-in sends the browser")
	flag.Parse()

	var providers []server.Provider
	if err := readJSON(*providersPath, &providers); err != nil {
		log.Fatalf("providers: %v", err)
	}
	var users map[string]json.RawMessage
	if err := readJSON(*usersPath, &users); err != nil {
		log.Fatalf("users: %v", err)
	}
	ids := make([]string, 0, len(users))
	for id := range users {
		ids = append(ids, id)
	}

	var key []byte
	path := *vaultPath
	if *ephemeral {
		key, path = make([]byte, 32), ""
		if _, err := rand.Read(key); err != nil {
			log.Fatal(err)
		}
	} else {
		var err error
		if key, err = base64.StdEncoding.DecodeString(os.Getenv("GATEWAY_VAULT_KEY")); err != nil || len(key) != 32 || path == "" {
			log.Fatal("set GATEWAY_VAULT_KEY to 32 bytes, base64-encoded, and -vault to a path; or pass -ephemeral")
		}
	}
	vault, err := accounts.Open(key, path)
	if err != nil {
		log.Fatal(err)
	}
	gw, err := server.New(server.Options{Providers: providers, Users: ids, Vault: vault, PublicURL: *publicURL, ReturnURL: *returnURL})
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	srv := &http.Server{Addr: *addr, Handler: gw.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	fmt.Fprintf(os.Stderr, "gateway listening on http://%s with %d providers\n", *addr, len(providers))
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func readJSON(path string, into any) error {
	if path == "" {
		return fmt.Errorf("a path is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}
