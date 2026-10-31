# services/auth

`picasso-auth`, the auth part of PRD 2.3's `picasso-bff`: sign-in against any OpenID provider,
PRD 7.2's session rules, and the session tokens the data plane, the gateway and the
collaboration server verify.

> OIDC with mandatory MFA for any tenant with `positions` class data. Short-lived (15 minute)
> session tokens with silent refresh.

```bash
npm test --workspace @picasso/auth          # 17 tests
OIDC_CLIENT_SECRET=... node services/auth/dist/main.js --public-url https://picasso.example.com \
   --oidc-issuer https://login.example.com --client-id picasso-web \
   --users users.json --tenants config/tenants.json --key session-key.jwk
```

| Module | What it does |
|---|---|
| `oidc.ts` | The relying party: discovery, authorization code with PKCE and a nonce, ID-token verification |
| `sessions.ts` | Picasso's session tokens: minted, verified and refreshed under canvas-guard's rules |
| `verify.ts` | What a service does with a token, held to the Go services' verdicts |
| `server.ts` | `/auth/login`, `/auth/callback`, `/auth/refresh`, `/auth/logout`, `/auth/me`, `/auth/revoked`, `/.well-known/jwks.json` |
| `standin.ts` | A **stand-in** OpenID provider for tests and the browser check; `main.ts` never loads it |

## Any provider

The provider is configuration: its issuer URL, a client id, and, for a confidential client, a
secret. Okta, Entra ID, Google, Auth0 and Keycloak all publish the discovery document this
reads. Token verification is `jose`'s. canvas-guard's session module explains why: a
hand-rolled JWT verifier is a well-documented way to accept `alg: none`. What this service
adds is what the libraries leave to the caller.

- **The nonce.** The ID token must carry the one this sign-in sent, so a token issued to
  another browser is refused.
- **A callback finishes only the sign-in its own browser started.** `/login` sets a one-time
  cookie with the state, and `/callback` requires it. Otherwise a link an attacker started
  and sent to someone else would sign the victim in as the attacker. The test plays exactly
  that, and fails with the check removed.
- **The return address is a path on this site**, so `/login` is not an open redirect.
- **A discovery document naming another issuer is refused** (OIDC Discovery 1.0, 4.3).

## Two tokens, two jobs

The provider's ID token proves who signed in. The services do not check it on each request:
it is the provider's, with the provider's lifetime. A sign-in that passes canvas-guard's
`authorizeSession` is turned into Picasso's own session token: Ed25519, fifteen minutes, with
the tenant, the factors, the login time and a session id. The services verify that one
against `/.well-known/jwks.json`. Their user lists, and so their entitlements, stay their own:
a token says who, never what they may read.

The same rules apply at every step. Minting, verifying and refreshing each run
`authorizeSession`:
- MFA in any tenant that holds positions, even to read a public canvas;
- a token living longer than fifteen minutes is refused, whatever signed it;
- twelve hours from the interactive login, refresh stops.

The refresh test refreshes every fourteen minutes and is refused on the 52nd, at 12h08m.
`acceptRefresh` also runs on every refresh. It cannot fail here, because a refresh is built
from the current token, and removing it changes no test. It matters if refresh ever goes
through the provider's refresh token.

## The session cookie

HttpOnly, so no script on the page can read it: the browser check reads `document.cookie`
and finds no session. SameSite=Lax, not Strict: the browser comes back from the provider by
a cross-site navigation, and a Strict cookie would not be sent with it. Lax still keeps it
off other sites' POSTs and subrequests. A WebSocket cannot set a header, so the services
also accept the token from this cookie.

## One contract, two languages

The Go services verify tokens with their own code (`identity` in services/dataplane and
services/gateway), using go-jose, and must decide as this does. `test/tokens.test.ts` writes
`testdata/tokens.json`: fourteen cases, tokens signed by a fixture key, each presented at a
fixed moment, some with a list of logged-out sessions, and this verifier's verdict. The
cases:
- valid, including at the last second of leeway;
- expired;
- issued in the future;
- issued by another issuer, or for another audience;
- an hour long;
- signed by another key;
- altered after signing;
- `alg: none`;
- no tenant;
- logged out; another session logged out, which is accepted; logged out and expired, which is
  `expired`.

Both Go suites read the file and must agree, reason for reason. With the Go lifetime ceiling
raised to two hours, the Go test fails on "an hour long". `UPDATE_TOKENS=1` rewrites the file,
which is a change to the contract.

## Logout reaches every service

A service checks a token's signature itself, so a logout here would not reach it on its own.
picasso-auth publishes the sessions that have ended at `/auth/revoked`. Each one stays on the
list for fifteen minutes plus a minute: as long as any token it was issued could still
verify, with thirty seconds of skew either way. After that it is the expiry check's job. So
the list holds only the last quarter-hour's logouts.

Each service re-reads the list at most every five seconds, when a token arrives. It does this
through `RevocationList` here, and `identity` in Go. A copy that has not been refreshed for
thirty seconds is "unknown", and every token is then refused: a service that cannot tell a
logged-out session from a live one does not guess. Both languages are tested the same way.
- a logout lands at the next re-read and not before;
- one list read serves every verification within an interval;
- an outage is tolerated up to the staleness limit and refused past it;
- the service recovers when picasso-auth answers again.

Removing the revocation check, or the staleness check, fails those tests. In the Go suite,
the contract test fails too.

## The browser check

`apps/canvas-demo/scripts/signin-shots.mjs` runs everything with no development identity
anywhere: the stand-in provider, this service, and the collaboration server with
`--auth-url`, all behind the demo server. It checks, in Chromium:
- a page with no session is signed out;
- `pm` signs in through the provider and the canvas syncs on the session alone, which the
  page cannot read;
- a second user, signed in with a hardware key, syncs the same canvas;
- a password alone is refused in a tenant that holds positions, and the page says why;
- `?user=pm`, a typed name, is refused;
- logout ends the session;
- the token read from the browser's cookie store before logout, still unexpired, is refused
  by the collaboration server afterwards.

## What is not covered

- **No real provider has been signed in against.** The stand-in implements the parts of
  OIDC this uses, and approves whoever `login_hint` names with no password. Nothing here has
  met Okta, Entra or Google, and none can be reached from here. The first real sign-in is
  the first test of that.
- **Logout takes up to five seconds to reach a service**, and does not close a connection
  already open: a collaboration WebSocket or a data plane stream started before it carries
  on. The revocation list is public, like the key set. Its session ids are random and already
  unusable, but it does show how many people logged out in the last quarter-hour.
- **Sessions are in memory.** A restart ends every session's revocation record, and, without
  `--key`, every session.
- **Sign-ins are not audited.** The data plane and the gateway write PRD 7.2's records for
  position reads and AI dispatches. Each record names the user, the tenant and a trace id, but
  not the session id. Sign-in, refresh and logout are not recorded anywhere but this
  process's memory.
- **One signing key, no rotation.**
- **MFA is what the provider says it is.** `amr` is trusted as reported, and `sms` counts as a
  second factor, as canvas-guard's README says.
