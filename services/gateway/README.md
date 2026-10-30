# services/gateway

PRD 4's model fleet, reached the way the user chose: any model, open or closed, from any
provider, each user calling on their own account. The router (`canvas-router`) decides which
model a task goes to; this is what makes the call.

```bash
cd services/gateway
go test -race ./...                       # 21 tests; one live and one on Postgres, skipped by default
GATEWAY_LIVE=1 go test ./provider/        # adds one call to api.anthropic.com with an invalid key

GATEWAY_VAULT_KEY=$(openssl rand -base64 32) go run ./cmd/gateway \
   -auth-url https://picasso.example.com -providers config/providers.json -users ../dataplane/config/users.json -vault vault.json \
   -public-url http://127.0.0.1:8750 -return-url http://127.0.0.1:5173/models.html \
   -audit-pg postgres://... -migrate
# or -ephemeral instead of the key and -vault, for development; without -audit-pg the trail is in memory
```

| Package | What it does |
|---|---|
| `provider` | One request and response shape; adapters for Anthropic (the official Go SDK), the Chat Completions API (OpenAI and every server that speaks it) and Gemini |
| `accounts` | Each user's credential per provider, sealed with AES-256-GCM, bound to its user |
| `server` | Providers, connecting by sign-in or API key, chat, and the audit log |
| `identity` | Verifies picasso-auth's session tokens: the same package and contract test as the data plane's |
| `audit` | PRD 7.2's trail, identical to the data plane's package. CI compares the two copies, and the data plane's job runs it on Postgres |

## Every model, three adapters

Three API families cover the field. **Anthropic** for Claude. **Chat Completions** for OpenAI's
models and for nearly everything else: OpenRouter, Together, Groq, Mistral, DeepSeek, xAI,
and the open-weight servers, vLLM (the PRD's choice), Ollama, LM Studio and llama.cpp. Each
is one provider entry with a base URL. **Gemini** for Google's. `config/providers.json` ships
six providers: OpenRouter, Anthropic, OpenAI, Gemini, and Ollama and vLLM on the gateway's
machine. A provider is a JSON entry, not code.

## Signing in

A user connects a provider in one of two ways.

- **Sign in, where the provider offers it.** OpenRouter does: an OAuth flow with PKCE that
  ends in a key on the user's own OpenRouter account. One sign-in reaches its whole catalogue
  of open and closed models. The verifier and the user it belongs to stay on the gateway,
  keyed by an unguessable state in the callback URL. The callback works once, within ten
  minutes, and the test plays the whole flow, including a replay, a cancel, a forged code
  and an expiry.
- **An API key from the user's account**, for Anthropic, OpenAI and Gemini, pasted once. A
  sign-in through any of those providers' own identity systems is not built.

Self-hosted servers (`auth: none`) need nothing and are shared.

## Rules enforced where they cannot be skipped

- **Placement decides who may see what.** Every chat names its data class, and a request with
  no class is refused, not assumed public. Positions and MNPI-risk content go only to providers
  marked `self_hosted` or `on_device`, never to a vendor's API: the routing policy's hard rule,
  applied at the last point before data leaves. The test makes the vendor reachable and
  connected, and checks that it received nothing.
- **A vendor is never reached on the operator's account.** A vendor provider with `auth: none`
  is a configuration error, since every user's calls would go out under one key with nothing
  to say whose they were.
- **A caller never chooses the upstream.** Requests name a provider id; URLs are configuration.
- **Nothing in the environment steers a call.** Given a key, Anthropic's Go SDK reads no
  credential from the environment, but it still applies `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_CUSTOM_HEADERS` from the gateway's own environment. The adapter turns those
  defaults off. The test sets all three and checks none takes effect, and fails without the
  switch, with the custom header arriving at the provider.
- **A credential goes in and does not come out.** The API shows a connection's method, its
  date and the key's last four characters. The vault file holds only ciphertext, owner-only,
  and a sealed secret copied to another user's row fails to open. Provider errors are scrubbed
  of the credential.
- **Every dispatch is on the audit trail before the provider is called** (PRD 7.2).
  - A chat names its `purpose`, a task name such as `sql.generate`. A sentence is refused,
    because free text is where a prompt would end up in the trail.
  - The record is written first: actor, tenant, `provider/model`, purpose, the caller's
    `traceparent` id (returned in `X-Picasso-Trace`), and the data class sent.
  - A trail that cannot be written means no call. The test makes the trail fail, and checks
    that the provider received nothing. With that check removed, the test fails: the call goes
    out unrecorded.
  - A second record with the same trace id holds the outcome and the token counts. The call
    has happened by then, so if that write fails it is logged, and the answer is still returned.
  - Neither record holds message content.
- **Each user also sees their own calls.** `/v1/audit` lists who, which provider and model,
  what data class, the outcome and the tokens. It is append-only, holds no content, and shows
  each user only their own entries. It is a view for the user, separate from the trail.

## Measured against the real thing

Anthropic's API is the one provider host this environment reaches. Measured:
- Anthropic's Go SDK v2.4.0 sends an API key as `Authorization: Bearer`, not as `x-api-key`.
  The first stand-in test assumed the latter, and the SDK is the authority on what it sends.
- `api.anthropic.com` reads a bearer token as an API key. An invalid one comes back as 401
  `authentication_error`, "invalid x-api-key", and the gateway returns that with the key
  scrubbed (`GATEWAY_LIVE=1`).

## What is not covered

- **No successful model call has been made.** There is no key for any provider here. The
  Anthropic adapter has reached the real API only to be refused, and the Chat Completions,
  Gemini and OpenRouter-exchange code is tested against stand-ins written to each one's
  documented API. openrouter.ai, api.openai.com and generativelanguage.googleapis.com either
  refuse connections here or answer only without a key.
- **Text in, text out.** No streaming, tools, images, structured output or thinking controls.
  No sampling parameters are sent, since current Claude models reject them.
- **Identity is picasso-auth's session token**, as at the data plane, with the same
  `-dev-identity` escape for development. A logged-out token works here until it expires.
- **No revocation upstream.** Disconnecting deletes the gateway's copy; the key stays valid with
  the provider until the user revokes it there.
- **The vault key is one key.** No rotation, no KMS. The per-user dispatch log is in memory. The
  trail is in Postgres with `-audit-pg`, under the same limits as the data plane's: the process
  writes as the role it is given, and nothing expires a record.
- **No budgets or rate limits.** `canvas-router` holds the budget rules and does not yet call
  this gateway; nothing here stops a user spending their own account.
