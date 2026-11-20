package sources

import (
	"os"
	"strings"
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
)

// The real answer to an automated request, captured 2026-11-20.
func TestStooqsBrowserCheckIsReportedAsSuch(t *testing.T) {
	body, err := os.ReadFile("testdata/stooq-browser-check-2026-11-20.html")
	if err != nil {
		t.Fatal(err)
	}
	_, err = StooqDaily(body, "NVDA", entitle.Licensed, "stooq")
	if err == nil || !strings.Contains(err.Error(), "browser check") {
		t.Fatalf("the browser check page: %v", err)
	}
}
