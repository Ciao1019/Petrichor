package kb

import (
	"context"
	"fmt"
	"testing"

	"github.com/hibiken/asynq"

	"petrichor/api/internal/taskqueue"
)

func TestImportRequestFinalizeFencesLateTerminalCallback(t *testing.T) {
	store, router := finalizeRequestTestSetup(t)
	text := "直接解析已完成"
	job := safetyImportJob(t, store, JobPageRow{
		PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &text,
	})
	oldExecution := taskqueue.WithDocumentImportExecution(context.Background())
	before, err := store.Get(oldExecution, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 模拟旧处理器已返回失败，但 Asynq 的终态回调尚未执行。
	assertFinalizeResponse(t, finalizeRequestHTTP(router, job.ID), job.ID, "processing", "finalizing", nil)
	task := asynq.NewTask(taskqueue.TypeDocumentImport, []byte(fmt.Sprintf(`{"jobId":%d}`, job.ID)))
	markDocumentImportTerminalFailure(oldExecution, task)
	current, err := store.Get(context.Background(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Status != "processing" || current.Stage != "finalizing" || current.ReplayCount != before.ReplayCount+1 || current.Error != nil {
		t.Fatalf("旧死信回调覆盖了新成文请求: %+v", current)
	}
	ids, err := store.RunnableJobIDs(context.Background())
	if err != nil || len(ids) != 1 || ids[0] != job.ID {
		t.Fatalf("新成文任务丢失调度资格: %v err=%v", ids, err)
	}
	pages, err := store.Pages(context.Background(), job.ID)
	if err != nil || len(pages) != 1 || pages[0].Status != "done" || derefStr(pages[0].Markdown) != text {
		t.Fatalf("成功页面被旧回调覆盖: %+v err=%v", pages, err)
	}
}
