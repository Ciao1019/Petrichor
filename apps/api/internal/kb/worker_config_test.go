package kb

import "testing"

func TestBackgroundWorkerConcurrencyFitsReservedPoolBudget(t *testing.T) {
	if visionImportWorkerConcurrency*visionImportPageConcurrency > 2 {
		t.Fatalf("vision model concurrency = %d, want <= 2", visionImportWorkerConcurrency*visionImportPageConcurrency)
	}
	if knowledgeBuildConcurrency+visionImportWorkerConcurrency > 4 {
		t.Fatalf("reserved worker connections = %d, want <= 4", knowledgeBuildConcurrency+visionImportWorkerConcurrency)
	}
}
