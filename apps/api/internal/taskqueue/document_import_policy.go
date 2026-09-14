package taskqueue

import "strings"

const (
	ImagePolicyKeepAndRecognize = "keep_and_recognize"
	ImagePolicyTextOnly         = "text_only"
	ImagePolicyImagesOnly       = "images_only"
)

// 缺省沿用历史任务行为，保证升级后重试不会改变文章内容。
func EffectiveDocumentImagePolicy(policy string) string {
	if policy == "" {
		return ImagePolicyKeepAndRecognize
	}
	return policy
}

func ValidDocumentImagePolicy(policy string) bool {
	switch EffectiveDocumentImagePolicy(policy) {
	case ImagePolicyKeepAndRecognize, ImagePolicyTextOnly, ImagePolicyImagesOnly:
		return true
	}
	return false
}

// 仅文字策略的图片只用于 OCR 重试，不作为长期文章资源。
func DocumentImportOCRAssetKey(userID, jobID int64, token string, pageNo int32, index int) string {
	return strings.Replace(DocumentImportAssetKey(userID, jobID, token, pageNo, index), "/document-assets/", "/document-import/", 1)
}
