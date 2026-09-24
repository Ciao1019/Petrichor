package piruntime

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPiSteeringAndFollowUp(t *testing.T) {
	for _, mode := range []string{"steer", "follow_up"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			calls, polls := 0, 0
			result, err := Run(ctx, Request{Messages: []Message{{Role: "user", Content: "原始任务"}}, MaxTurns: 3,
				Controls: func(context.Context) ([]Control, error) {
					polls++
					if polls == 1 {
						return []Control{{Sequence: 1, Mode: mode, Text: "补充要求"}}, nil
					}
					return nil, nil
				},
				Model: func(_ context.Context, messages []Message, _ func(string) error) (*ModelResult, error) {
					calls++
					if calls == 2 && messages[len(messages)-1].Content != "补充要求" {
						t.Error("Pi 未消费用户补充")
					}
					return &ModelResult{Text: "回复"}, nil
				},
			})
			if err != nil || result.Text != "回复" || calls != 2 {
				t.Fatalf("calls=%d result=%+v err=%v", calls, result, err)
			}
		})
	}
}

func TestPiDoesNotDiscardQueuedFollowUpAtTurnLimit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	polls := 0
	_, err := Run(ctx, Request{Messages: []Message{{Role: "user", Content: "任务"}}, MaxTurns: 2,
		Controls: func(context.Context) ([]Control, error) {
			polls++
			if polls == 1 {
				return []Control{{Sequence: 1, Mode: "steer", Text: "立即补充"}, {Sequence: 2, Mode: "follow_up", Text: "后续补充"}}, nil
			}
			return nil, nil
		},
		Model: func(context.Context, []Message, func(string) error) (*ModelResult, error) {
			return &ModelResult{Text: "回复"}, nil
		},
	})
	if !errors.Is(err, ErrTurnLimit) {
		t.Fatalf("有未处理的补充却标记完成: %v", err)
	}
}
