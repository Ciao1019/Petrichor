package assistant

import (
	"encoding/json"
	"fmt"
	"strings"
)

// assistantID 对齐旧版 assistantIdSchema：JSON 数字和字符串都可输入，后续统一做正整数校验。
type assistantID string

func (id *assistantID) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*id = ""
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*id = assistantID(strings.TrimSpace(text))
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err != nil {
		return fmt.Errorf("ID 必须是字符串或数字")
	}
	*id = assistantID(strings.TrimSpace(number.String()))
	return nil
}

func (focus *AssistantFocus) UnmarshalJSON(data []byte) error {
	var raw struct {
		KnowledgeBaseID json.RawMessage `json:"knowledgeBaseId"`
		ArticleID       json.RawMessage `json:"articleId"`
		DocumentID      json.RawMessage `json:"documentId"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	var err error
	if focus.KnowledgeBaseID, err = parseAssistantFocusID(raw.KnowledgeBaseID); err != nil {
		return fmt.Errorf("focus.knowledgeBaseId 不合法")
	}
	if focus.ArticleID, err = parseAssistantFocusID(raw.ArticleID); err != nil {
		return fmt.Errorf("focus.articleId 不合法")
	}
	if focus.DocumentID, err = parseAssistantFocusID(raw.DocumentID); err != nil {
		return fmt.Errorf("focus.documentId 不合法")
	}
	return nil
}

func parseAssistantFocusID(raw json.RawMessage) (*string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var value assistantID
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	text := string(value)
	return &text, nil
}
