package cache

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestReadThroughCoalescesConcurrentLoads(t *testing.T) {
	key := fmt.Sprintf("test:singleflight:%d", time.Now().UnixNano())
	var loads atomic.Int32
	const workers = 20
	results := make(chan int, workers)
	var wait sync.WaitGroup
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			value, err := ReadThrough(key, 60, func() (int, error) {
				loads.Add(1)
				time.Sleep(20 * time.Millisecond)
				return 42, nil
			})
			if err != nil {
				t.Errorf("ReadThrough() error = %v", err)
				return
			}
			results <- value
		}()
	}
	wait.Wait()
	close(results)
	for value := range results {
		if value != 42 {
			t.Fatalf("value = %d", value)
		}
	}
	if got := loads.Load(); got != 1 {
		t.Fatalf("loader calls = %d, want 1", got)
	}
	Drop(key)
}

func TestCleanupExpiredMemoryEntries(t *testing.T) {
	key := fmt.Sprintf("test:expired:%d", time.Now().UnixNano())
	memStore.Store(key, memEntry{value: []byte(`1`), expireAt: time.Now().Add(-time.Second)})
	lastMemCleanup.Store(0)
	cleanupExpiredMemoryEntries(time.Now())
	if _, exists := memStore.Load(key); exists {
		t.Fatal("expired entry was not removed")
	}
}
