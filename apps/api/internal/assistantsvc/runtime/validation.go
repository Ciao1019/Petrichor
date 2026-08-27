package runtime

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

// compiledToolSchema 把编译结果和编译错误一起缓存。工具定义在进程启动后稳定，
// 没必要在每次模型调用时重复解析 JSON Schema。
type compiledToolSchema struct {
	schema *jsonschema.Schema
	err    error
}

var toolSchemaCache sync.Map

// validateToolInput 在权限检查后、执行工具前统一验证模型参数。
// Eino 负责把 Schema 告诉模型，但模型输出仍然是不可信输入，必须在执行边界复核。
func validateToolInput(rawSchema json.RawMessage, input any) error {
	if len(bytes.TrimSpace(rawSchema)) == 0 {
		return nil
	}
	cacheKey := string(rawSchema)
	entryValue, ok := toolSchemaCache.Load(cacheKey)
	if !ok {
		entryValue, _ = toolSchemaCache.LoadOrStore(cacheKey, compileToolSchema(rawSchema))
	}
	entry := entryValue.(compiledToolSchema)
	if entry.err != nil {
		return fmt.Errorf("工具参数定义无效：%w", entry.err)
	}
	if err := entry.schema.Validate(input); err != nil {
		return formatToolValidationError(err)
	}
	return nil
}

// ValidateToolInput 供确认票据等服务端受控执行路径复用同一套 JSON Schema 校验。
// 普通模型工具调用仍统一由 ToolExecutor 调用内部校验。
func ValidateToolInput(rawSchema json.RawMessage, input any) error {
	return validateToolInput(rawSchema, input)
}

func compileToolSchema(rawSchema json.RawMessage) compiledToolSchema {
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(rawSchema))
	if err != nil {
		return compiledToolSchema{err: err}
	}
	compiler := jsonschema.NewCompiler()
	const schemaURL = "mem://petrichor/tool-input.json"
	if err := compiler.AddResource(schemaURL, document); err != nil {
		return compiledToolSchema{err: err}
	}
	compiled, err := compiler.Compile(schemaURL)
	return compiledToolSchema{schema: compiled, err: err}
}

func formatToolValidationError(err error) error {
	var validationErr *jsonschema.ValidationError
	if !errors.As(err, &validationErr) {
		return fmt.Errorf("参数校验失败：%w", err)
	}
	output := validationErr.BasicOutput()
	issues := make([]string, 0, len(output.Errors))
	for _, item := range output.Errors {
		if item.Error == nil {
			continue
		}
		path := strings.TrimPrefix(item.InstanceLocation, "/")
		path = strings.ReplaceAll(path, "/", ".")
		if path == "" {
			path = "input"
		}
		issues = append(issues, path+": "+item.Error.String())
		if len(issues) == 6 {
			break
		}
	}
	if len(issues) == 0 {
		return errors.New("参数校验失败")
	}
	return errors.New(strings.Join(issues, "; "))
}
