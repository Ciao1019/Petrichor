package kb

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/hibiken/asynq"
)

const (
	knowledgeBuildPhaseQueued     = "queued"
	knowledgeBuildPhasePreparing  = "preparing"
	knowledgeBuildPhaseAnalyzing  = "analyzing"
	knowledgeBuildPhaseTaxonomy   = "taxonomy"
	knowledgeBuildPhasePages      = "pages"
	knowledgeBuildPhasePersisting = "persisting"
	knowledgeBuildPhaseEmbedding  = "embedding"
	knowledgeBuildPhaseRetrying   = "retrying"
	knowledgeBuildPhaseCompleted  = "completed"
	knowledgeBuildPhaseFailed     = "failed"

	knowledgeBuildStagePending   = "pending"
	knowledgeBuildStageRunning   = "running"
	knowledgeBuildStageCompleted = "completed"
	knowledgeBuildStageFailed    = "failed"

	knowledgeBuildStageAgent      = "analyzing.agent"
	knowledgeBuildStageQuestions  = "analyzing.questions"
	knowledgeBuildStageResolution = "taxonomy.resolution"
	knowledgeBuildStageCatalog    = "taxonomy.catalog"

	knowledgeBuildProgressEventLimit = 30
	knowledgeBuildAgentActivityLimit = 80
	knowledgeBuildHeartbeatInterval  = 10 * time.Second
)

var knowledgeBuildStageOrder = []string{
	knowledgeBuildPhaseQueued,
	knowledgeBuildPhasePreparing,
	knowledgeBuildPhaseAnalyzing,
	knowledgeBuildPhasePages,
	knowledgeBuildPhaseTaxonomy,
	knowledgeBuildPhasePersisting,
	knowledgeBuildPhaseEmbedding,
	knowledgeBuildPhaseCompleted,
}

type knowledgeBuildProgressStage struct {
	ID          string                        `json:"id"`
	Status      string                        `json:"status"`
	Message     string                        `json:"message,omitempty"`
	Percent     int                           `json:"percent,omitempty"`
	Completed   int                           `json:"completed,omitempty"`
	Total       int                           `json:"total,omitempty"`
	StartedAt   *time.Time                    `json:"startedAt,omitempty"`
	CompletedAt *time.Time                    `json:"completedAt,omitempty"`
	Children    []knowledgeBuildProgressStage `json:"children,omitempty"`
}

type knowledgeBuildProgressEvent struct {
	ID        string    `json:"id"`
	StageID   string    `json:"stageId"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"createdAt"`
}

type knowledgeBuildAgentActivity struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	Status      string     `json:"status"`
	Title       string     `json:"title"`
	Detail      string     `json:"detail,omitempty"`
	AgentName   string     `json:"agentName,omitempty"`
	ToolName    string     `json:"toolName,omitempty"`
	Round       int        `json:"round,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
}

type knowledgeBuildProgress struct {
	Percent         int                           `json:"percent"`
	Phase           string                        `json:"phase"`
	Message         string                        `json:"message"`
	Completed       int                           `json:"completed,omitempty"`
	Total           int                           `json:"total,omitempty"`
	Attempt         int                           `json:"attempt"`
	MaxAttempts     int                           `json:"maxAttempts"`
	UpdatedAt       time.Time                     `json:"updatedAt"`
	HeartbeatAt     time.Time                     `json:"heartbeatAt"`
	Stages          []knowledgeBuildProgressStage `json:"stages"`
	Events          []knowledgeBuildProgressEvent `json:"events"`
	AgentActivities []knowledgeBuildAgentActivity `json:"agentActivities"`
}

type knowledgeBuildStageUpdate struct {
	ParentID  string
	ID        string
	Status    string
	Message   string
	Percent   int
	Completed int
	Total     int
}

type knowledgeBuildProgressReporter interface {
	report(knowledgeBuildProgress)
	reportStage(knowledgeBuildStageUpdate)
	reportEvent(stageID, message string)
	reportAgentActivity(DocumentAgentActivity)
}

type knowledgeBuildProgressContextKey struct{}

func withKnowledgeBuildProgressReporter(ctx context.Context, reporter knowledgeBuildProgressReporter) context.Context {
	return context.WithValue(ctx, knowledgeBuildProgressContextKey{}, reporter)
}

func progressReporterFromContext(ctx context.Context) knowledgeBuildProgressReporter {
	reporter, _ := ctx.Value(knowledgeBuildProgressContextKey{}).(knowledgeBuildProgressReporter)
	return reporter
}

func reportKnowledgeBuildProgress(ctx context.Context, percent int, phase, message string, completed, total int) {
	if reporter := progressReporterFromContext(ctx); reporter != nil {
		reporter.report(knowledgeBuildProgress{
			Percent: percent, Phase: phase, Message: message, Completed: completed, Total: total,
		})
	}
}

// reportKnowledgeBuildProgressNote 只更新当前阶段文案，不改变已完成百分比。
func reportKnowledgeBuildProgressNote(ctx context.Context, message string) {
	reportKnowledgeBuildProgress(ctx, -1, "", message, 0, 0)
}

func reportKnowledgeBuildStage(ctx context.Context, update knowledgeBuildStageUpdate) {
	if reporter := progressReporterFromContext(ctx); reporter != nil {
		reporter.reportStage(update)
	}
}

func reportKnowledgeBuildEvent(ctx context.Context, stageID, message string) {
	if reporter := progressReporterFromContext(ctx); reporter != nil {
		reporter.reportEvent(stageID, message)
	}
}

func reportKnowledgeBuildAgentActivity(ctx context.Context, activity DocumentAgentActivity) {
	if reporter := progressReporterFromContext(ctx); reporter != nil {
		reporter.reportAgentActivity(activity)
	}
}

type knowledgeBuildTaskProgressWriter struct {
	mu          sync.Mutex
	task        *asynq.Task
	startedAt   time.Time
	latest      knowledgeBuildProgress
	eventSeq    uint64
	activitySeq uint64
}

func newKnowledgeBuildTaskProgressWriter(
	task *asynq.Task,
	startedAt time.Time,
	attempt, maxAttempts int,
) *knowledgeBuildTaskProgressWriter {
	return &knowledgeBuildTaskProgressWriter{
		task: task, startedAt: startedAt,
		latest: initialKnowledgeBuildProgress(startedAt, attempt, maxAttempts),
	}
}

func initialKnowledgeBuildProgress(now time.Time, attempt, maxAttempts int) knowledgeBuildProgress {
	if attempt < 1 {
		attempt = 1
	}
	if maxAttempts < attempt {
		maxAttempts = attempt
	}
	stages := make([]knowledgeBuildProgressStage, 0, len(knowledgeBuildStageOrder))
	for _, id := range knowledgeBuildStageOrder {
		stage := knowledgeBuildProgressStage{ID: id, Status: knowledgeBuildStagePending}
		switch id {
		case knowledgeBuildPhaseQueued:
			stage.Status = knowledgeBuildStageRunning
			stage.Message = "等待 Worker 处理"
			stage.StartedAt = timePtr(now)
		case knowledgeBuildPhaseAnalyzing:
			stage.Children = []knowledgeBuildProgressStage{
				{ID: knowledgeBuildStageAgent, Status: knowledgeBuildStagePending},
				{ID: knowledgeBuildStageQuestions, Status: knowledgeBuildStagePending},
			}
		case knowledgeBuildPhaseTaxonomy:
			stage.Children = []knowledgeBuildProgressStage{
				{ID: knowledgeBuildStageResolution, Status: knowledgeBuildStagePending},
				{ID: knowledgeBuildStageCatalog, Status: knowledgeBuildStagePending},
			}
		}
		stages = append(stages, stage)
	}
	return knowledgeBuildProgress{
		Phase: knowledgeBuildPhaseQueued, Message: "等待 Worker 处理",
		Attempt: attempt, MaxAttempts: maxAttempts, UpdatedAt: now, HeartbeatAt: now,
		Stages: stages, Events: []knowledgeBuildProgressEvent{},
		AgentActivities: []knowledgeBuildAgentActivity{},
	}
}

func (writer *knowledgeBuildTaskProgressWriter) report(update knowledgeBuildProgress) {
	writer.mu.Lock()
	defer writer.mu.Unlock()

	now := time.Now().UTC()
	previousPhase := writer.latest.Phase
	if update.Percent < 0 {
		update.Percent = writer.latest.Percent
		if update.Phase == "" {
			update.Phase = writer.latest.Phase
		}
		update.Completed = writer.latest.Completed
		update.Total = writer.latest.Total
	} else if update.Percent < writer.latest.Percent {
		update.Percent = writer.latest.Percent
	}
	if update.Phase == "" {
		update.Phase = writer.latest.Phase
	}
	if update.Message == "" {
		update.Message = writer.latest.Message
	}
	writer.latest.Percent = min(max(update.Percent, 0), 100)
	writer.latest.Phase = update.Phase
	writer.latest.Message = update.Message
	writer.latest.Completed = update.Completed
	writer.latest.Total = update.Total
	writer.latest.UpdatedAt = now
	writer.latest.HeartbeatAt = now
	transitionKnowledgeBuildStages(&writer.latest, update.Phase, update.Message, update.Completed, update.Total, now)
	if update.Phase != previousPhase {
		writer.appendEventLocked(update.Phase, update.Message, now)
	}
	writer.writeLocked()
}

func (writer *knowledgeBuildTaskProgressWriter) reportStage(update knowledgeBuildStageUpdate) {
	if update.ID == "" {
		return
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()

	now := time.Now().UTC()
	stage := findKnowledgeBuildStage(writer.latest.Stages, update.ParentID, update.ID)
	if stage == nil {
		return
	}
	previousStatus := stage.Status
	previousMessage := stage.Message
	applyKnowledgeBuildStageUpdate(stage, update, now)
	if update.ParentID != "" {
		parent := findKnowledgeBuildStage(writer.latest.Stages, "", update.ParentID)
		if parent != nil && parent.Status == knowledgeBuildStagePending {
			parent.Status = knowledgeBuildStageRunning
			parent.StartedAt = timePtr(now)
		}
		writer.latest.Phase = update.ParentID
	} else {
		writer.latest.Phase = update.ID
	}
	if update.Message != "" {
		writer.latest.Message = update.Message
	}
	writer.latest.Completed = update.Completed
	writer.latest.Total = update.Total
	writer.latest.UpdatedAt = now
	writer.latest.HeartbeatAt = now
	if calculated := calculateKnowledgeBuildPercent(writer.latest.Stages); calculated > writer.latest.Percent {
		writer.latest.Percent = calculated
	}
	if update.Message != "" && (previousStatus != stage.Status || previousMessage != update.Message) {
		writer.appendEventLocked(update.ID, update.Message, now)
	}
	writer.writeLocked()
}

func (writer *knowledgeBuildTaskProgressWriter) reportEvent(stageID, message string) {
	if message == "" {
		return
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	now := time.Now().UTC()
	writer.latest.UpdatedAt = now
	writer.latest.HeartbeatAt = now
	writer.appendEventLocked(stageID, message, now)
	writer.writeLocked()
}

func (writer *knowledgeBuildTaskProgressWriter) reportAgentActivity(update DocumentAgentActivity) {
	if update.Title == "" && update.ID == "" {
		return
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()

	now := time.Now().UTC()
	if update.ID == "" {
		writer.activitySeq++
		update.ID = fmt.Sprintf("activity-%d-%d", now.UnixMilli(), writer.activitySeq)
	}
	for index := len(writer.latest.AgentActivities) - 1; index >= 0; index-- {
		activity := &writer.latest.AgentActivities[index]
		if activity.ID != update.ID {
			continue
		}
		mergeKnowledgeBuildAgentActivity(activity, update, now)
		writer.latest.UpdatedAt = now
		writer.latest.HeartbeatAt = now
		writer.writeLocked()
		return
	}

	activity := knowledgeBuildAgentActivity{
		ID: update.ID, Kind: update.Kind, Status: update.Status,
		Title: update.Title, Detail: update.Detail, AgentName: update.AgentName,
		ToolName: update.ToolName, Round: update.Round, CreatedAt: now, UpdatedAt: now,
	}
	if activity.Kind == "" {
		activity.Kind = "lifecycle"
	}
	if activity.Status == "" {
		activity.Status = knowledgeBuildStageRunning
	}
	if isKnowledgeBuildActivityTerminal(activity.Status) {
		activity.CompletedAt = timePtr(now)
	}
	writer.latest.AgentActivities = append(writer.latest.AgentActivities, activity)
	if len(writer.latest.AgentActivities) > knowledgeBuildAgentActivityLimit {
		writer.latest.AgentActivities = append([]knowledgeBuildAgentActivity(nil),
			writer.latest.AgentActivities[len(writer.latest.AgentActivities)-knowledgeBuildAgentActivityLimit:]...)
	}
	writer.latest.UpdatedAt = now
	writer.latest.HeartbeatAt = now
	writer.writeLocked()
}

func mergeKnowledgeBuildAgentActivity(
	activity *knowledgeBuildAgentActivity,
	update DocumentAgentActivity,
	now time.Time,
) {
	if update.Kind != "" {
		activity.Kind = update.Kind
	}
	if update.Status != "" {
		activity.Status = update.Status
	}
	if update.Title != "" {
		activity.Title = update.Title
	}
	if update.Detail != "" {
		activity.Detail = update.Detail
	}
	if update.AgentName != "" {
		activity.AgentName = update.AgentName
	}
	if update.ToolName != "" {
		activity.ToolName = update.ToolName
	}
	if update.Round > 0 {
		activity.Round = update.Round
	}
	activity.UpdatedAt = now
	if isKnowledgeBuildActivityTerminal(activity.Status) {
		activity.CompletedAt = timePtr(now)
	}
}

func isKnowledgeBuildActivityTerminal(status string) bool {
	return status == knowledgeBuildStageCompleted || status == knowledgeBuildStageFailed
}

func (writer *knowledgeBuildTaskProgressWriter) appendEventLocked(stageID, message string, now time.Time) {
	if count := len(writer.latest.Events); count > 0 {
		last := writer.latest.Events[count-1]
		if last.StageID == stageID && last.Message == message {
			return
		}
	}
	writer.eventSeq++
	writer.latest.Events = append(writer.latest.Events, knowledgeBuildProgressEvent{
		ID:      fmt.Sprintf("%d-%d", now.UnixMilli(), writer.eventSeq),
		StageID: stageID, Message: message, CreatedAt: now,
	})
	if len(writer.latest.Events) > knowledgeBuildProgressEventLimit {
		writer.latest.Events = append([]knowledgeBuildProgressEvent(nil),
			writer.latest.Events[len(writer.latest.Events)-knowledgeBuildProgressEventLimit:]...)
	}
}

func (writer *knowledgeBuildTaskProgressWriter) startHeartbeat(ctx context.Context) func() {
	heartbeatCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(knowledgeBuildHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case now := <-ticker.C:
				writer.mu.Lock()
				writer.latest.HeartbeatAt = now.UTC()
				writer.writeLocked()
				writer.mu.Unlock()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
}

func (writer *knowledgeBuildTaskProgressWriter) snapshot() knowledgeBuildProgress {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return cloneKnowledgeBuildProgress(writer.latest)
}

func (writer *knowledgeBuildTaskProgressWriter) writeLocked() {
	if writer.task == nil {
		return
	}
	snapshot := cloneKnowledgeBuildProgress(writer.latest)
	if err := writeKnowledgeBuildTaskResult(writer.task, knowledgeBuildTaskResult{
		StartedAt: writer.startedAt,
		Progress:  &snapshot,
	}); err != nil {
		slog.Warn("知识构建进度写入 Asynq 失败", "err", err)
	}
}

func normalizeKnowledgeBuildProgress(progress knowledgeBuildProgress) knowledgeBuildProgress {
	progress.Percent = min(max(progress.Percent, 0), 100)
	if progress.Phase == "" {
		progress.Phase = knowledgeBuildPhaseQueued
	}
	if progress.Message == "" {
		progress.Message = "等待 Worker 处理"
	}
	if progress.UpdatedAt.IsZero() {
		progress.UpdatedAt = time.Now().UTC()
	}
	if progress.HeartbeatAt.IsZero() {
		progress.HeartbeatAt = progress.UpdatedAt
	}
	if progress.Attempt < 1 {
		progress.Attempt = 1
	}
	if progress.MaxAttempts < progress.Attempt {
		progress.MaxAttempts = progress.Attempt
	}
	if len(progress.Stages) == 0 {
		initial := initialKnowledgeBuildProgress(progress.UpdatedAt, progress.Attempt, progress.MaxAttempts)
		progress.Stages = initial.Stages
	}
	if progress.Events == nil {
		progress.Events = []knowledgeBuildProgressEvent{}
	}
	if progress.AgentActivities == nil {
		progress.AgentActivities = []knowledgeBuildAgentActivity{}
	}
	if len(progress.AgentActivities) > knowledgeBuildAgentActivityLimit {
		progress.AgentActivities = append([]knowledgeBuildAgentActivity(nil),
			progress.AgentActivities[len(progress.AgentActivities)-knowledgeBuildAgentActivityLimit:]...)
	}
	if len(progress.Events) > knowledgeBuildProgressEventLimit {
		progress.Events = append([]knowledgeBuildProgressEvent(nil),
			progress.Events[len(progress.Events)-knowledgeBuildProgressEventLimit:]...)
	}
	transitionKnowledgeBuildStages(&progress, progress.Phase, progress.Message,
		progress.Completed, progress.Total, progress.UpdatedAt)
	return progress
}

func transitionKnowledgeBuildStages(
	progress *knowledgeBuildProgress,
	phase, message string,
	completed, total int,
	now time.Time,
) {
	if phase == knowledgeBuildPhaseRetrying || phase == knowledgeBuildPhaseFailed {
		for index := range progress.Stages {
			if progress.Stages[index].Status == knowledgeBuildStageRunning {
				progress.Stages[index].Status = knowledgeBuildStageFailed
				progress.Stages[index].Message = message
				progress.Stages[index].CompletedAt = timePtr(now)
				for childIndex := range progress.Stages[index].Children {
					child := &progress.Stages[index].Children[childIndex]
					if child.Status == knowledgeBuildStageRunning {
						child.Status = knowledgeBuildStageFailed
						child.CompletedAt = timePtr(now)
					}
				}
				return
			}
		}
		return
	}
	targetIndex := knowledgeBuildStageIndex(phase)
	if targetIndex < 0 {
		return
	}
	for index := range progress.Stages {
		stage := &progress.Stages[index]
		switch {
		case phase == knowledgeBuildPhaseCompleted || index < targetIndex:
			if stage.Status != knowledgeBuildStageFailed {
				stage.Status = knowledgeBuildStageCompleted
				stage.Percent = 100
				if stage.StartedAt == nil {
					stage.StartedAt = timePtr(now)
				}
				if stage.CompletedAt == nil {
					stage.CompletedAt = timePtr(now)
				}
				for childIndex := range stage.Children {
					child := &stage.Children[childIndex]
					if child.Status != knowledgeBuildStageFailed {
						child.Status = knowledgeBuildStageCompleted
						child.Percent = 100
						if child.StartedAt == nil {
							child.StartedAt = timePtr(now)
						}
						if child.CompletedAt == nil {
							child.CompletedAt = timePtr(now)
						}
					}
				}
			}
		case index == targetIndex:
			if stage.Status != knowledgeBuildStageCompleted {
				stage.Status = knowledgeBuildStageRunning
				stage.Message = message
				stage.Completed = completed
				stage.Total = total
				if total > 0 {
					stage.Percent = min(100, max(0, completed*100/total))
				}
				if stage.StartedAt == nil {
					stage.StartedAt = timePtr(now)
				}
			}
		}
	}
}

func applyKnowledgeBuildStageUpdate(stage *knowledgeBuildProgressStage, update knowledgeBuildStageUpdate, now time.Time) {
	status := update.Status
	if status == "" {
		status = knowledgeBuildStageRunning
	}
	stage.Status = status
	stage.Message = update.Message
	stage.Completed = max(0, update.Completed)
	stage.Total = max(0, update.Total)
	if update.Percent >= 0 {
		stage.Percent = min(100, max(0, update.Percent))
	} else if stage.Total > 0 {
		stage.Percent = min(100, stage.Completed*100/stage.Total)
	}
	if status == knowledgeBuildStageCompleted {
		stage.Percent = 100
	}
	if status != knowledgeBuildStagePending && stage.StartedAt == nil {
		stage.StartedAt = timePtr(now)
	}
	if status == knowledgeBuildStageCompleted || status == knowledgeBuildStageFailed {
		stage.CompletedAt = timePtr(now)
	}
}

func findKnowledgeBuildStage(
	stages []knowledgeBuildProgressStage,
	parentID, stageID string,
) *knowledgeBuildProgressStage {
	for index := range stages {
		if parentID == "" && stages[index].ID == stageID {
			return &stages[index]
		}
		if stages[index].ID != parentID {
			continue
		}
		for childIndex := range stages[index].Children {
			if stages[index].Children[childIndex].ID == stageID {
				return &stages[index].Children[childIndex]
			}
		}
	}
	return nil
}

func knowledgeBuildStageIndex(stageID string) int {
	for index, id := range knowledgeBuildStageOrder {
		if id == stageID {
			return index
		}
	}
	return -1
}

func calculateKnowledgeBuildPercent(stages []knowledgeBuildProgressStage) int {
	weights := map[string]float64{
		knowledgeBuildPhasePreparing:  5,
		knowledgeBuildPhaseAnalyzing:  40,
		knowledgeBuildPhasePages:      30,
		knowledgeBuildPhaseTaxonomy:   15,
		knowledgeBuildPhasePersisting: 5,
		knowledgeBuildPhaseEmbedding:  5,
	}
	total := 0.0
	for _, stage := range stages {
		weight := weights[stage.ID]
		if weight == 0 {
			continue
		}
		total += weight * knowledgeBuildStageFraction(stage)
	}
	return min(100, max(0, int(total+0.5)))
}

func knowledgeBuildStageFraction(stage knowledgeBuildProgressStage) float64 {
	switch stage.Status {
	case knowledgeBuildStageCompleted:
		return 1
	case knowledgeBuildStagePending:
		return 0
	}
	if len(stage.Children) > 0 {
		childWeights := map[string]float64{
			knowledgeBuildStageAgent:      0.75,
			knowledgeBuildStageQuestions:  0.25,
			knowledgeBuildStageResolution: 0.53,
			knowledgeBuildStageCatalog:    0.47,
		}
		fraction := 0.0
		for _, child := range stage.Children {
			fraction += childWeights[child.ID] * knowledgeBuildStageFraction(child)
		}
		return min(1, max(0, fraction))
	}
	if stage.Total > 0 {
		return min(1, max(0, float64(stage.Completed)/float64(stage.Total)))
	}
	return float64(min(100, max(0, stage.Percent))) / 100
}

func cloneKnowledgeBuildProgress(progress knowledgeBuildProgress) knowledgeBuildProgress {
	cloned := progress
	cloned.Stages = cloneKnowledgeBuildStages(progress.Stages)
	cloned.Events = append([]knowledgeBuildProgressEvent(nil), progress.Events...)
	cloned.AgentActivities = append([]knowledgeBuildAgentActivity(nil), progress.AgentActivities...)
	return cloned
}

func cloneKnowledgeBuildStages(stages []knowledgeBuildProgressStage) []knowledgeBuildProgressStage {
	cloned := make([]knowledgeBuildProgressStage, len(stages))
	for index := range stages {
		cloned[index] = stages[index]
		cloned[index].Children = cloneKnowledgeBuildStages(stages[index].Children)
	}
	return cloned
}

func timePtr(value time.Time) *time.Time {
	copy := value
	return &copy
}
