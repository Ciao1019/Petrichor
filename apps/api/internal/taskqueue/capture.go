package taskqueue

import (
	"context"
	"errors"
	"github.com/hibiken/asynq"
	"time"
)

const QueueCapture = "web_capture"
const TypeCapture = "petrichor:capture:run"
const TypeCaptureReconcile = "petrichor:capture:reconcile"

func EnqueueCapture(ctx context.Context, id string) error {
	_, client, inspector, e := dependencies()
	if e != nil {
		return e
	}
	taskID := "capture-" + id
	if info, e := inspector.GetTaskInfo(QueueCapture, taskID); e == nil {
		if taskIsActive(info) {
			return nil
		}
		if e = inspector.DeleteTask(QueueCapture, taskID); e != nil {
			return e
		}
	}
	_, e = client.EnqueueContext(ctx, asynq.NewTask(TypeCapture, []byte(id)), asynq.Queue(QueueCapture), asynq.TaskID(taskID), asynq.MaxRetry(30), asynq.Timeout(20*time.Minute), asynq.Retention(24*time.Hour))
	if errors.Is(e, asynq.ErrTaskIDConflict) {
		return nil
	}
	return e
}
func CancelCapture(id string) error {
	_, _, i, e := dependencies()
	if e != nil {
		return e
	}
	_ = i.CancelProcessing("capture-" + id)
	_ = i.DeleteTask(QueueCapture, "capture-"+id)
	return nil
}
func NewCaptureReconcileTask() *asynq.Task {
	return asynq.NewTask(TypeCaptureReconcile, []byte("{}"), asynq.Queue(QueueCapture), asynq.MaxRetry(1), asynq.Timeout(time.Minute))
}
