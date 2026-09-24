package runtime

import (
	"context"
	"fmt"

	"petrichor/api/internal/piruntime"
)

type PendingTool struct {
	ID         string `json:"id"`
	CallID     string `json:"callId"`
	SideEffect bool   `json:"sideEffect"`
}

func restoreRunState(state *AgentStateStore, saved *AgentState, observations *ObservationStore, evidence *EvidenceStore) {
	if saved == nil {
		return
	}
	identity := state.state
	state.state = cloneState(saved)
	state.state.RunID, state.state.StartedAt = identity.RunID, identity.StartedAt
	state.state.Status, state.state.StopReason = StatusRunning, ""
	for _, observation := range saved.Observations {
		observations.Add(observation)
	}
	evidence.items = append([]AgentEvidence{}, state.state.Evidence...)
	for _, item := range evidence.items {
		for _, key := range dedupKeys(item) {
			evidence.index[key] = item.ID
		}
	}
}

func checkpointRun(request *RunRequest, state *AgentStateStore, pending *PendingTool) error {
	if request.Checkpoint == nil {
		return nil
	}
	if err := request.Checkpoint(state.Snapshot(), pending); err != nil {
		return fmt.Errorf("保存 Agent 检查点失败: %w", err)
	}
	return nil
}

func pollRunControls(ctx context.Context, request *RunRequest, state *AgentStateStore, events *AgentEventEmitter) ([]piruntime.Control, error) {
	if request.Controls == nil {
		return nil, nil
	}
	controls, err := request.Controls(ctx, state.Current().ControlSequence)
	if err != nil {
		return nil, err
	}
	for _, control := range controls {
		state.state.Goal += "\n\n用户补充要求：\n" + control.Text
		request.Goal = state.state.Goal
		state.state.ControlSequence = control.Sequence
		events.Emit("user_instruction", map[string]any{"sequence": control.Sequence, "mode": control.Mode, "text": control.Text})
	}
	if len(controls) > 0 {
		err = checkpointRun(request, state, nil)
	}
	return controls, err
}
