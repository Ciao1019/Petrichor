package auth

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/authsession"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type SessionItem struct {
	ID           string  `json:"id"`
	IP           *string `json:"ip"`
	UserAgent    *string `json:"userAgent"`
	CreatedAt    string  `json:"createdAt"`
	LastActiveAt string  `json:"lastActiveAt"`
	ExpiresAt    string  `json:"expiresAt"`
	Current      bool    `json:"current"`
}

type SessionListResponse struct {
	Sessions         []SessionItem `json:"sessions"`
	CurrentSessionID *string       `json:"currentSessionId"`
}

func (s *Service) ListSessions(ctx context.Context, userID int64, currentSessionID int64) (*SessionListResponse, error) {
	now := time.Now().UTC()
	rows, err := s.client.AuthSession.Query().
		Where(
			authsession.UserIDEQ(userID),
			authsession.RevokedAtIsNil(),
			authsession.ExpiresAtGT(now),
		).
		Order(ent.Desc(authsession.FieldLastSeenAt), ent.Desc(authsession.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}

	currentID := fmt.Sprintf("%d", currentSessionID)
	sessions := make([]SessionItem, 0, len(rows))
	for _, row := range rows {
		lastActive := row.CreatedAt
		if row.LastSeenAt != nil {
			lastActive = *row.LastSeenAt
		}
		id := fmt.Sprintf("%d", row.ID)
		sessions = append(sessions, SessionItem{
			ID:           id,
			IP:           row.IP,
			UserAgent:    row.UserAgent,
			CreatedAt:    row.CreatedAt.UTC().Format(time.RFC3339Nano),
			LastActiveAt: lastActive.UTC().Format(time.RFC3339Nano),
			ExpiresAt:    row.ExpiresAt.UTC().Format(time.RFC3339Nano),
			Current:      row.ID == currentSessionID,
		})
	}
	return &SessionListResponse{
		Sessions:         sessions,
		CurrentSessionID: &currentID,
	}, nil
}

func (s *Service) RevokeSession(ctx context.Context, userID, currentSessionID int64, sessionID string) error {
	targetID, err := strconv.ParseInt(sessionID, 10, 64)
	if err != nil || targetID <= 0 {
		return response.BadRequest("会话标识无效")
	}
	if targetID == currentSessionID {
		return response.BadRequest("不能下线当前登录的会话")
	}

	n, err := s.client.AuthSession.Update().
		Where(
			authsession.IDEQ(targetID),
			authsession.UserIDEQ(userID),
			authsession.RevokedAtIsNil(),
		).
		SetRevokedAt(time.Now().UTC()).
		Save(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		return response.NotFound("会话不存在或已下线")
	}
	return nil
}

func (s *Service) RevokeOtherSessions(ctx context.Context, userID, currentSessionID int64) (int, error) {
	n, err := s.client.AuthSession.Update().
		Where(
			authsession.UserIDEQ(userID),
			authsession.IDNEQ(currentSessionID),
			authsession.RevokedAtIsNil(),
		).
		SetRevokedAt(time.Now().UTC()).
		Save(ctx)
	if err != nil {
		return 0, err
	}
	return n, nil
}
