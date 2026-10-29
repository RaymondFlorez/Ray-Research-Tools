package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Gemini speaks Google's generateContent API with the user's API key.
type Gemini struct {
	// BaseURL defaults to https://generativelanguage.googleapis.com.
	BaseURL string
	Client  *http.Client
}

type geminiPart struct {
	Text string `json:"text"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}

type generateContentResponse struct {
	Candidates []struct {
		Content      geminiContent `json:"content"`
		FinishReason string        `json:"finishReason"`
	} `json:"candidates"`
	PromptFeedback *struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
	UsageMetadata struct {
		PromptTokenCount     int64 `json:"promptTokenCount"`
		CandidatesTokenCount int64 `json:"candidatesTokenCount"`
	} `json:"usageMetadata"`
	ModelVersion string `json:"modelVersion"`
	Error        *struct {
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error"`
}

func (g Gemini) Chat(ctx context.Context, credential string, req Request) (Response, error) {
	if err := req.Validate(); err != nil {
		return Response{}, err
	}
	body := map[string]any{"generationConfig": map[string]any{"maxOutputTokens": req.MaxTokens}}
	if req.System != "" {
		body["systemInstruction"] = geminiContent{Parts: []geminiPart{{Text: req.System}}}
	}
	var contents []geminiContent
	for _, m := range req.Messages {
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		contents = append(contents, geminiContent{Role: role, Parts: []geminiPart{{Text: m.Text}}})
	}
	body["contents"] = contents
	raw, _ := json.Marshal(body)
	base := g.BaseURL
	if base == "" {
		base = "https://generativelanguage.googleapis.com"
	}
	endpoint := strings.TrimRight(base, "/") + "/v1beta/models/" + url.PathEscape(req.Model) + ":generateContent"
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return Response{}, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("x-goog-api-key", credential)
	client := g.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(hreq)
	if err != nil {
		return Response{}, fmt.Errorf("%s", redact(err.Error(), credential))
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	var gr generateContentResponse
	decodeErr := json.Unmarshal(payload, &gr)
	if res.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(payload))
		if decodeErr == nil && gr.Error != nil {
			msg = strings.TrimSpace(gr.Error.Status + " " + gr.Error.Message)
		}
		return Response{}, &Error{Provider: "gemini", Status: res.StatusCode, Message: redact(msg, credential)}
	}
	if decodeErr != nil {
		return Response{}, fmt.Errorf("gemini: unreadable response: %w", decodeErr)
	}
	out := Response{Model: gr.ModelVersion, InputTokens: gr.UsageMetadata.PromptTokenCount, OutputTokens: gr.UsageMetadata.CandidatesTokenCount}
	if out.Model == "" {
		out.Model = req.Model
	}
	if len(gr.Candidates) == 0 {
		// A prompt blocked before generation has no candidates at all.
		out.Stop = StopRefusal
		if gr.PromptFeedback != nil {
			out.StopDetail = gr.PromptFeedback.BlockReason
		}
		return out, nil
	}
	c := gr.Candidates[0]
	var text strings.Builder
	for _, p := range c.Content.Parts {
		text.WriteString(p.Text)
	}
	out.Text = text.String()
	switch c.FinishReason {
	case "STOP":
		out.Stop = StopEnd
	case "MAX_TOKENS":
		out.Stop = StopMaxTokens
	case "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII":
		out.Stop, out.StopDetail = StopRefusal, c.FinishReason
	default:
		out.Stop, out.StopDetail = StopOther, c.FinishReason
	}
	return out, nil
}
