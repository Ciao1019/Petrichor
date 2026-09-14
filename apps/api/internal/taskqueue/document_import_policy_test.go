package taskqueue

import (
	"context"
	"errors"
	"testing"
)

func TestDefaultImagePolicyAndIdempotency(t *testing.T) {
	job := preparingTestJob()
	expected := documentImportFingerprint(&job)
	for _, policy := range []string{"", ImagePolicyKeepAndRecognize} {
		job.ImagePolicy = policy
		if got := documentImportFingerprint(&job); got != expected {
			t.Fatalf("默认策略指纹变化: %s", got)
		}
	}
	store := newDocumentImportTestStore(t)
	ctx := context.Background()
	created, err := store.Create(ctx, preparingTestJob())
	if err != nil {
		t.Fatal(err)
	}
	input := preparingTestJob()
	input.ImagePolicy = ImagePolicyKeepAndRecognize
	if found, err := store.FindIdempotent(ctx, input); err != nil || found.ID != created.ID {
		t.Fatal(found, err)
	}
	if _, err := store.UpdateJob(ctx, created.ID, func(job *DocumentImportJob) error { job.PrepareAttempt++; return nil }); err != nil {
		t.Fatal(err)
	}
	input.ImagePolicy = ImagePolicyImagesOnly
	if _, err := store.FindIdempotent(ctx, input); !errors.Is(err, ErrDocumentImportIdempotencyConflict) {
		t.Fatal(err)
	}
}
