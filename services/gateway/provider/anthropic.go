package provider

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

// Anthropic reaches Claude through the official SDK, with the user's API key.
//
// No sampling parameters are sent: current Claude models reject temperature,
// top_p and top_k, and thinking is left at the model's default, which on the
// current models is adaptive.
//
// The SDK's environment defaults are switched off. Given a key it reads no
// credential from the environment, but it would still take ANTHROPIC_BASE_URL
// and ANTHROPIC_CUSTOM_HEADERS from the gateway's own environment, and a stray
// base URL there would send every user's key to another host. The gateway's
// configuration is the only thing that says where a request goes.
type Anthropic struct {
	// BaseURL overrides the API's address, for a test or a proxy the operator
	// runs. Empty is the SDK's default.
	BaseURL string
	Client  *http.Client
}

func (a Anthropic) Chat(ctx context.Context, credential string, req Request) (Response, error) {
	if err := req.Validate(); err != nil {
		return Response{}, err
	}
	if credential == "" {
		return Response{}, fmt.Errorf("anthropic: no API key for this user")
	}
	opts := []option.RequestOption{option.WithoutEnvironmentDefaults(), option.WithAPIKey(credential), option.WithMaxRetries(2)}
	if a.BaseURL != "" {
		opts = append(opts, option.WithBaseURL(a.BaseURL))
	}
	if a.Client != nil {
		opts = append(opts, option.WithHTTPClient(a.Client))
	}
	client := anthropic.NewClient(opts...)

	params := anthropic.MessageNewParams{Model: anthropic.Model(req.Model), MaxTokens: int64(req.MaxTokens)}
	if req.System != "" {
		params.System = []anthropic.TextBlockParam{{Text: req.System}}
	}
	for _, m := range req.Messages {
		block := anthropic.NewTextBlock(m.Text)
		if m.Role == "assistant" {
			params.Messages = append(params.Messages, anthropic.NewAssistantMessage(block))
		} else {
			params.Messages = append(params.Messages, anthropic.NewUserMessage(block))
		}
	}

	msg, err := client.Messages.New(ctx, params)
	if err != nil {
		var apierr *anthropic.Error
		if errors.As(err, &apierr) {
			return Response{}, &Error{Provider: "anthropic", Status: apierr.StatusCode, Message: redact(apierr.Error(), credential)}
		}
		return Response{}, errors.New(redact(err.Error(), credential))
	}

	var text strings.Builder
	for _, block := range msg.Content {
		if b, ok := block.AsAny().(anthropic.TextBlock); ok {
			text.WriteString(b.Text)
		}
	}
	out := Response{Text: text.String(), Model: string(msg.Model), InputTokens: msg.Usage.InputTokens, OutputTokens: msg.Usage.OutputTokens}
	switch msg.StopReason {
	case anthropic.StopReasonEndTurn, anthropic.StopReasonStopSequence:
		out.Stop = StopEnd
	case anthropic.StopReasonMaxTokens:
		out.Stop = StopMaxTokens
	case anthropic.StopReasonRefusal:
		out.Stop = StopRefusal
		out.StopDetail = strings.TrimSpace(string(msg.StopDetails.Category) + " " + msg.StopDetails.Explanation)
	default:
		out.Stop, out.StopDetail = StopOther, string(msg.StopReason)
	}
	return out, nil
}
