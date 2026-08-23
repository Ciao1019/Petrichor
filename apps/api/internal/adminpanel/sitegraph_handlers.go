// sitegraph_handlers.go 全站星图后台 HTTP 层：入参校验 + 响应包装。
package adminpanel

import (
	"strconv"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
)

func badRequestJSON(c *gin.Context, msg string) {
	httpx.ErrorJSON(c, 400, msg)
}

func validateEnum(c *gin.Context, value string, allowed []string, label string) bool {
	if !inList(allowed, value) {
		badRequestJSON(c, label+"非法")
		return false
	}
	return true
}

// AdminSiteGraphOverview GET/POST /api/admin/site-graph/overview。
func AdminSiteGraphOverview(c *gin.Context) {
	overview, err := LoadSiteGraphOverview(c.Request.Context(), authUserID(c))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, overview)
}

// AdminSiteGraphGenerate POST /api/admin/site-graph/generate。
func AdminSiteGraphGenerate(c *gin.Context) {
	var req struct {
		ModelRefID StrictOptionalID `json:"modelRefId"`
		Mode       string           `json:"mode"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	mode := req.Mode
	if mode == "" {
		mode = "FULL"
	}
	if !validateEnum(c, mode, []string{"FULL", "INCREMENTAL"}, "mode") {
		return
	}
	result, err := GenerateSiteGraph(c.Request.Context(), authUserID(c), req.ModelRefID.Value, mode)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AdminSiteGraphValidate POST /api/admin/site-graph/validate。
func AdminSiteGraphValidate(c *gin.Context) {
	validation, summary, err := RevalidateSiteGraph(c.Request.Context(), authUserID(c))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, gin.H{"validation": validation, "summary": summary})
}

// AdminSiteGraphPublish POST /api/admin/site-graph/publish。
func AdminSiteGraphPublish(c *gin.Context) {
	result, err := PublishSiteGraph(c.Request.Context(), authUserID(c))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AdminSiteGraphUnpublish POST /api/admin/site-graph/unpublish。
func AdminSiteGraphUnpublish(c *gin.Context) {
	result, err := UnpublishSiteGraph(c.Request.Context(), authUserID(c))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AdminSiteGraphClear POST /api/admin/site-graph/clear。
func AdminSiteGraphClear(c *gin.Context) {
	result, err := ClearSiteGraph(c.Request.Context(), authUserID(c))
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

type nodeSaveRequest struct {
	ID         StrictOptionalID `json:"id"`
	NodeKey    *string          `json:"nodeKey"`
	ParentID   StrictOptionalID `json:"parentId"`
	Kind       string           `json:"kind"`
	Name       string           `json:"name"`
	Summary    *string          `json:"summary"`
	Route      *string          `json:"route"`
	Attributes []Attribute      `json:"attributes"`
	Aliases    []string         `json:"aliases"`
	Weight     any              `json:"weight"`
	Status     string           `json:"status"`
	Confidence any              `json:"confidence"`
	Locked     *bool            `json:"locked"`
}

// AdminSiteGraphNodeSave POST /api/admin/site-graph/node/save。
func AdminSiteGraphNodeSave(c *gin.Context) {
	var req nodeSaveRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	name := strTrim(req.Name)
	if name == "" {
		badRequestJSON(c, "节点名称不能为空")
		return
	}
	if runeLen(name) > LimitNameLength {
		badRequestJSON(c, "节点名称长度不能超过 "+strconv.Itoa(LimitNameLength))
		return
	}
	if !validateEnum(c, req.Kind, SiteGraphNodeKinds, "节点类型") {
		return
	}
	status := req.Status
	if status == "" {
		status = "DRAFT"
	}
	if !validateEnum(c, status, SiteGraphStatuses, "状态") {
		return
	}
	var attributes []Attribute
	var aliases []string
	if req.Attributes != nil {
		attributes = NormalizeAttributes(anySliceFromAttributes(req.Attributes))
	}
	if req.Aliases != nil {
		raw := make([]any, 0, len(req.Aliases))
		for _, alias := range req.Aliases {
			raw = append(raw, alias)
		}
		aliases = normalizeAliases(raw)
	}

	nodeKey := ""
	if req.NodeKey != nil && strTrim(*req.NodeKey) != "" {
		nodeKey = NormalizeNodeKey(*req.NodeKey)
	} else {
		nodeKey = BuildManualNodeKey(name, req.Kind)
	}

	node, err := SaveNode(c.Request.Context(), authUserID(c), SaveNodeInput{
		ID:         req.ID.Value,
		NodeKey:    nodeKey,
		ParentID:   req.ParentID.Value,
		Kind:       req.Kind,
		Name:       name,
		Summary:    trimPtr(req.Summary),
		Route:      trimPtr(req.Route),
		Attributes: attributes,
		Aliases:    aliases,
		Weight:     ClampWeight(orValueDefault(req.Weight, float64(1))),
		Status:     status,
		Confidence: ClampConfidence(orValueDefault(req.Confidence, float64(100))),
		Locked:     req.Locked != nil && *req.Locked,
	})
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, gin.H{"id": strconv.FormatInt(node.ID, 10), "nodeKey": node.NodeKey})
}

// AdminSiteGraphNodeDelete POST /api/admin/site-graph/node/delete。
func AdminSiteGraphNodeDelete(c *gin.Context) {
	var req struct {
		ID httpx.FlexID `json:"id"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	id, ok := requireID(req.ID)
	if !ok {
		badRequestJSON(c, "id 必须是正整数")
		return
	}
	result, err := DeleteNode(c.Request.Context(), authUserID(c), id)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

type edgeSaveRequest struct {
	ID         StrictOptionalID `json:"id"`
	FromNodeID httpx.FlexID     `json:"fromNodeId"`
	ToNodeID   httpx.FlexID     `json:"toNodeId"`
	Relation   string           `json:"relation"`
	Kind       string           `json:"kind"`
	Attributes []Attribute      `json:"attributes"`
	Weight     any              `json:"weight"`
	Directed   *bool            `json:"directed"`
	Status     string           `json:"status"`
	Confidence any              `json:"confidence"`
	Locked     *bool            `json:"locked"`
}

// AdminSiteGraphEdgeSave POST /api/admin/site-graph/edge/save。
func AdminSiteGraphEdgeSave(c *gin.Context) {
	var req edgeSaveRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	fromID, fromOK := requireID(req.FromNodeID)
	toID, toOK := requireID(req.ToNodeID)
	if !fromOK || !toOK {
		badRequestJSON(c, "fromNodeId/toNodeId 必须是正整数")
		return
	}
	relation := strTrim(req.Relation)
	if relation == "" {
		badRequestJSON(c, "关系名称不能为空")
		return
	}
	if runeLen(relation) > LimitRelationLength {
		badRequestJSON(c, "关系名称长度不能超过 "+strconv.Itoa(LimitRelationLength))
		return
	}
	if !validateEnum(c, req.Kind, SiteGraphEdgeKinds, "关系类型") {
		return
	}
	status := req.Status
	if status == "" {
		status = "DRAFT"
	}
	if !validateEnum(c, status, SiteGraphStatuses, "状态") {
		return
	}
	directed := true
	if req.Directed != nil {
		directed = *req.Directed
	}
	var attributes []Attribute
	if req.Attributes != nil {
		attributes = NormalizeAttributes(anySliceFromAttributes(req.Attributes))
	}

	edge, err := SaveEdge(c.Request.Context(), authUserID(c), SaveEdgeInput{
		ID:         req.ID.Value,
		FromNodeID: fromID,
		ToNodeID:   toID,
		Relation:   relation,
		Kind:       req.Kind,
		Attributes: attributes,
		Weight:     ClampWeight(orValueDefault(req.Weight, float64(1))),
		Directed:   directed,
		Status:     status,
		Confidence: ClampConfidence(orValueDefault(req.Confidence, float64(100))),
		Locked:     req.Locked != nil && *req.Locked,
	})
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, gin.H{"id": strconv.FormatInt(edge.ID, 10)})
}

// AdminSiteGraphEdgeDelete POST /api/admin/site-graph/edge/delete。
func AdminSiteGraphEdgeDelete(c *gin.Context) {
	var req struct {
		ID httpx.FlexID `json:"id"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	id, ok := requireID(req.ID)
	if !ok {
		badRequestJSON(c, "id 必须是正整数")
		return
	}
	result, err := DeleteEdge(c.Request.Context(), authUserID(c), id)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AdminSiteGraphSubtree POST /api/admin/site-graph/subtree。
func AdminSiteGraphSubtree(c *gin.Context) {
	var req struct {
		NodeID httpx.FlexID `json:"nodeId"`
		Depth  *int32       `json:"depth"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	nodeID, ok := requireID(req.NodeID)
	if !ok {
		badRequestJSON(c, "nodeId 必须是正整数")
		return
	}
	if req.Depth != nil && (*req.Depth < 0 || *req.Depth > int32(LimitMaxDepth)) {
		badRequestJSON(c, "depth 必须在 0 到 "+strconv.Itoa(LimitMaxDepth)+" 之间")
		return
	}
	var depth *int
	if req.Depth != nil {
		d := int(*req.Depth)
		depth = &d
	}
	result, err := LoadSiteGraphSubtree(c.Request.Context(), authUserID(c), nodeID, depth)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AdminSiteGraphNeighborhood POST /api/admin/site-graph/neighborhood。
func AdminSiteGraphNeighborhood(c *gin.Context) {
	var req struct {
		NodeID httpx.FlexID `json:"nodeId"`
		Hops   *int32       `json:"hops"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	nodeID, ok := requireID(req.NodeID)
	if !ok {
		badRequestJSON(c, "nodeId 必须是正整数")
		return
	}
	if req.Hops != nil && (*req.Hops < 1 || *req.Hops > 3) {
		badRequestJSON(c, "hops 必须在 1 到 3 之间")
		return
	}
	var hops *int
	if req.Hops != nil {
		h := int(*req.Hops)
		hops = &h
	}
	result, err := LoadSiteGraphNeighborhood(c.Request.Context(), authUserID(c), nodeID, hops)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AdminSiteGraphMergeConfirm POST /api/admin/site-graph/merge/confirm。
func AdminSiteGraphMergeConfirm(c *gin.Context) {
	var req struct {
		SourceNodeID httpx.FlexID `json:"sourceNodeId"`
		TargetNodeID httpx.FlexID `json:"targetNodeId"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	sourceID, sourceOK := requireID(req.SourceNodeID)
	targetID, targetOK := requireID(req.TargetNodeID)
	if !sourceOK || !targetOK {
		badRequestJSON(c, "sourceNodeId/targetNodeId 必须是正整数")
		return
	}
	result, err := ConfirmMergeCandidate(c.Request.Context(), authUserID(c), sourceID, targetID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AdminSiteGraphMergeIgnore POST /api/admin/site-graph/merge/ignore。
func AdminSiteGraphMergeIgnore(c *gin.Context) {
	var req struct {
		ID httpx.FlexID `json:"id"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	id, ok := requireID(req.ID)
	if !ok {
		badRequestJSON(c, "id 必须是正整数")
		return
	}
	result, err := DismissMergeCandidate(c.Request.Context(), authUserID(c), id)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// ===== 共享小工具（adminpanel handler 层） =====

func strTrim(s string) string { return trimSpaces(s) }

func trimPtr(v *string) *string {
	if v == nil {
		return nil
	}
	t := trimSpaces(*v)
	return &t
}

func requireID(v httpx.FlexID) (int64, bool) {
	if v <= 0 {
		return 0, false
	}
	return int64(v), true
}
