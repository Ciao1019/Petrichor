package kb

import (
	"context"
	"errors"
	"testing"
	"time"

	"petrichor/api/internal/httpx"
)

func TestWorkerRetryDelayIsExponentialCappedAndStable(t *testing.T) {
	previous := time.Duration(0)
	for attempt := 1; attempt <= 12; attempt++ {
		delay := workerRetryDelay(attempt, "job-1")
		if delay <= 0 || delay > workerRetryMaxDelay {
			t.Fatalf("attempt %d delay = %s", attempt, delay)
		}
		if attempt <= 6 && delay <= previous {
			t.Fatalf("attempt %d delay %s should exceed %s", attempt, delay, previous)
		}
		previous = delay
	}
	if got, want := workerRetryDelay(3, "job-1"), workerRetryDelay(3, "job-1"); got != want {
		t.Fatalf("stable jitter mismatch: %s != %s", got, want)
	}
}

func TestWorkerErrorRetryable(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil", err: nil, want: false},
		{name: "cancel", err: context.Canceled, want: true},
		{name: "deadline", err: context.DeadlineExceeded, want: true},
		{name: "bad request", err: &httpx.HttpError{Status: 400, Message: "bad"}, want: false},
		{name: "rate limit", err: &httpx.HttpError{Status: 429, Message: "slow"}, want: true},
		{name: "server", err: &httpx.HttpError{Status: 503, Message: "down"}, want: true},
		{name: "unknown", err: errors.New("network reset"), want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := workerErrorRetryable(test.err); got != test.want {
				t.Fatalf("got %v, want %v", got, test.want)
			}
		})
	}
}

func TestWorkerFailureStatus(t *testing.T) {
	retryable := errors.New("temporary")
	if got := workerFailureStatus(retryable, 1, 5); got != "pending" {
		t.Fatalf("first retryable failure = %q", got)
	}
	if got := workerFailureStatus(retryable, 5, 5); got != "dead_letter" {
		t.Fatalf("exhausted retryable failure = %q", got)
	}
	if got := workerFailureStatus(&httpx.HttpError{Status: 400, Message: "bad"}, 1, 5); got != "failed" {
		t.Fatalf("non-retryable failure = %q", got)
	}
}

func TestDeriveImportJobStatusIncludesProcessingAndDeadLetter(t *testing.T) {
	tests := []struct {
		name  string
		pages []JobPageRow
		want  string
	}{
		{name: "empty", want: "pending"},
		{name: "pending wins", pages: []JobPageRow{{Status: "pending"}, {Status: "dead_letter"}}, want: "processing"},
		{name: "processing wins", pages: []JobPageRow{{Status: "processing"}, {Status: "failed"}}, want: "processing"},
		{name: "dead letter", pages: []JobPageRow{{Status: "done"}, {Status: "dead_letter"}}, want: "dead_letter"},
		{name: "failed", pages: []JobPageRow{{Status: "done"}, {Status: "failed"}}, want: "failed"},
		{name: "completed", pages: []JobPageRow{{Status: "done"}}, want: "completed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := deriveJobStatus(test.pages); got != test.want {
				t.Fatalf("status = %q, want %q", got, test.want)
			}
		})
	}
}
