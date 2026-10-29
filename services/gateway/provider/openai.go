package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// OpenAICompatible speaks the Chat Completions API at BaseURL — OpenAI's own
// (https://api.openai.com/v1), or any of the many servers that implement it.
// An empty credential sends no Authorization header, for a local server that
// takes none.
type OpenAICompatible struct {
	Name    string
	BaseURL string
	// MaxTokensField is the request field the limit goes in: OpenAI's current
	// models take "max_completion_tokens", most other servers "max_tokens".
	MaxTokensField string
	// Headers the operator adds to every request, such as the attribution
	// headers some aggregators ask for.
	Headers map[string]string
	Client  *http.Client
}

type chatCompletion struct {
	Model   string `json:"model"`
	Choices []struct {
		Message struct {
			Content *string `json:"content"`
			Refusal *string `json:"refusal"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (o OpenAICompatible) Chat(ctx context.Context, credential string, req Request) (Response, error) {
	if err := req.Validate(); err != nil {
		return Response{}, err
	}
	messages := []map[string]string{}
	if req.System != "" {
		messages = append(messages, map[string]string{"role": "system", "content": req.System})
	}
	for _, m := range req.Messages {
		messages = append(messages, map[string]string{"role": m.Role, "content": m.Text})
	}
	field := o.MaxTokensField
	if field == "" {
		field = "max_tokens"
	}
	body, _ := json.Marshal(map[string]any{"model": req.Model, "messages": messages, field: req.MaxTokens})
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(o.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	for k, v := range o.Headers {
		hreq.Header.Set(k, v)
	}
	if credential != "" {
		hreq.Header.Set("Authorization", "Bearer "+credential)
	}
	client := o.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(hreq)
	if err != nil {
		return Response{}, fmt.Errorf("%s", redact(err.Error(), credential))
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	var cc chatCompletion
	decodeErr := json.Unmarshal(raw, &cc)
	if res.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(raw))
		if decodeErr == nil && cc.Error != nil {
			msg = cc.Error.Message
		}
		return Response{}, &Error{Provider: o.Name, Status: res.StatusCode, Message: redact(msg, credential)}
	}
	if decodeErr != nil {
		return Response{}, fmt.Errorf("%s: unreadable response: %w", o.Name, decodeErr)
	}
	if len(cc.Choices) == 0 {
		return Response{}, fmt.Errorf("%s: a response with no choices", o.Name)
	}
	c := cc.Choices[0]
	out := Response{Model: cc.Model, InputTokens: cc.Usage.PromptTokens, OutputTokens: cc.Usage.CompletionTokens}
	if c.Message.Content != nil {
		out.Text = *c.Message.Content
	}
	switch {
	case c.Message.Refusal != nil && *c.Message.Refusal != "":
		out.Stop, out.StopDetail = StopRefusal, *c.Message.Refusal
	case c.FinishReason == "stop":
		out.Stop = StopEnd
	case c.FinishReason == "length":
		out.Stop = StopMaxTokens
	case c.FinishReason == "content_filter":
		out.Stop, out.StopDetail = StopRefusal, "content_filter"
	default:
		out.Stop, out.StopDetail = StopOther, c.FinishReason
	}
	return out, nil
}
