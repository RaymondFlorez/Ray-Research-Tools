package entitle

import (
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/internal/contract"
)

func TestMatchesTheTypeScript(t *testing.T) {
	f, err := contract.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Entitlements {
		vendors := map[string]bool{}
		for _, v := range c.User.Vendors {
			vendors[v] = true
		}
		got := Check(Class(c.Record.DataClass), c.Record.Vendor, Entitlements{UserID: c.User.UserID, TenantID: c.User.TenantID, Vendors: vendors, Positions: c.User.Positions, MNPI: c.User.MNPI})
		want := Decision{Allowed: c.Expected.Allowed, Reason: c.Expected.Reason, Message: c.Expected.Message}
		if got != want {
			t.Errorf("%s / %s: got %+v, want %+v", c.User.UserID, c.Record.ID, got, want)
		}
	}
	if len(f.Entitlements) != 18 {
		t.Fatalf("expected 18 cases, read %d", len(f.Entitlements))
	}
}

func TestAnUnknownClassIsRefused(t *testing.T) {
	if d := Check(Class("secret"), "", Entitlements{MNPI: true, Positions: true}); d.Allowed {
		t.Fatal("an unknown class was allowed")
	}
}
