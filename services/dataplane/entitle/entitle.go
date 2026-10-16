// Package entitle decides whether one record may be shown to one user
// (PRD 7.2), the rule `data-access` applies on every read.
//
// It is canvas-data's `checkEntitlement`, held to the same answers by the
// conformance file. The one decision worth restating: a `licensed` record with
// no vendor is a denial, not a pass. The check that cannot be performed is the
// one that must not be assumed passed.
package entitle

// Class is PRD 7.2's data classification, least to most restricted.
type Class string

const (
	Public    Class = "public"
	Licensed  Class = "licensed"
	Positions Class = "positions"
	MNPIRisk  Class = "mnpi_risk"
)

// Valid reports whether c is one of the four classes.
func (c Class) Valid() bool {
	return c == Public || c == Licensed || c == Positions || c == MNPIRisk
}

// Entitlements are what one user may see.
type Entitlements struct {
	UserID    string
	TenantID  string
	Vendors   map[string]bool
	Positions bool
	MNPI      bool
}

// Decision is an allow, or a denial with the reason a node shows instead of a value.
type Decision struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// Check decides one record for one user.
func Check(class Class, vendor string, e Entitlements) Decision {
	switch class {
	case Public:
		return Decision{Allowed: true}
	case Licensed:
		if vendor == "" {
			return Decision{Reason: "no_vendor_licence", Message: "Licensed data with no vendor recorded; no licence covers it."}
		}
		if e.Vendors[vendor] {
			return Decision{Allowed: true}
		}
		return Decision{Reason: "no_vendor_licence", Message: "Requires a " + vendor + " licence."}
	case Positions:
		if e.Positions {
			return Decision{Allowed: true}
		}
		return Decision{Reason: "no_positions_access", Message: "Requires position access."}
	case MNPIRisk:
		if e.MNPI {
			return Decision{Allowed: true}
		}
		return Decision{Reason: "no_mnpi_clearance", Message: "Requires MNPI clearance."}
	}
	// An unknown class is the most restricted thing there is, not the least.
	return Decision{Reason: "unclassified", Message: "Record carries no known data class."}
}
