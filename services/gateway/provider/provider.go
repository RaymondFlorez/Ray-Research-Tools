// Package provider talks to model providers: one request and response shape
// for every model, and an adapter per API family.
//
//   - "anthropic": Claude, through Anthropic's official Go SDK.
//   - "openai": the Chat Completions API, which OpenAI serves and which most
//     other providers and every common open-weight server also speak —
//     OpenRouter, Together, Groq, Mistral, DeepSeek, xAI, vLLM, Ollama, LM
//     Studio, llama.cpp. One adapter, a base URL per provider.
//   - "gemini": Google's generateContent API.
//
// Which providers exist, where they are and how they are reached is the
// operator's configuration. A caller names a provider by id and never supplies
// a URL: a gateway that let a request choose its upstream would fetch whatever
// a request pointed it at, inside the network it runs in.
package provider

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// Message is one turn. Role is "user" or "assistant".
type Message struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// Request is what every adapter takes.
type Request struct {
	Model     string    `json:"model"`
	System    string    `json:"system,omitempty"`
	Messages  []Message `json:"messages"`
	MaxTokens int       `json:"maxTokens"`
}

// Stop is why generation stopped, normalised across providers.
type Stop string

const (
	// The model finished.
	StopEnd Stop = "end"
	// The token limit cut it off: the text is incomplete.
	StopMaxTokens Stop = "max_tokens"
	// The provider declined or filtered the request or the answer. The text,
	// if any, is not an answer.
	StopRefusal Stop = "refusal"
	// Anything else the provider reported, kept verbatim in StopDetail.
	StopOther Stop = "other"
)

// Response is what every adapter returns.
type Response struct {
	Text         string `json:"text"`
	Stop         Stop   `json:"stop"`
	StopDetail   string `json:"stopDetail,omitempty"`
	Model        string `json:"model"`
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
}

// Error is a provider's refusal of the request itself, with the HTTP status
// and the provider's own message.
type Error struct {
	Provider string
	Status   int
	Message  string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %d %s: %s", e.Provider, e.Status, http.StatusText(e.Status), e.Message)
}

// Adapter is one API family.
type Adapter interface {
	Chat(ctx context.Context, credential string, req Request) (Response, error)
}

// Validate refuses a request no provider could serve sensibly.
func (r Request) Validate() error {
	if strings.TrimSpace(r.Model) == "" {
		return fmt.Errorf("a model is required")
	}
	if len(r.Messages) == 0 {
		return fmt.Errorf("at least one message is required")
	}
	if r.Messages[0].Role != "user" {
		return fmt.Errorf("the first message must be the user's")
	}
	for i, m := range r.Messages {
		if m.Role != "user" && m.Role != "assistant" {
			return fmt.Errorf("message %d: role %q is neither user nor assistant", i, m.Role)
		}
	}
	if r.MaxTokens <= 0 {
		return fmt.Errorf("maxTokens must be positive")
	}
	return nil
}

// redact removes a credential from a provider's error text, in case the
// provider echoes it.
func redact(s, credential string) string {
	if credential == "" {
		return s
	}
	return strings.ReplaceAll(s, credential, "<credential>")
}
