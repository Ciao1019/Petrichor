package publicapi

import (
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"petrichor/api/internal/cache"
	"petrichor/api/internal/sitecontent"
)

func cachedShareDetailFixture(t *testing.T, code string) map[string]any {
	t.Helper()
	token, err := issueMediaAccessToken(mediaKindArticle, 42)
	if err != nil {
		t.Fatal(err)
	}
	response := map[string]any{
		"title": "图片缓存回归", "contentMd": "![图片](s4key:uploads/1/photo.jpg)",
		"mediaAccessToken": token,
	}
	raw, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	key := sitecontent.ArticleDetailCacheKey(code)
	cache.SetRaw(key, raw, sitecontent.TTLSeconds)
	t.Cleanup(func() { cache.Drop(key) })
	return response
}

func TestCachedShareDetailSilentlyRenewsMediaToken(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const code = "renew-cached-share"
		original := cachedShareDetailFixture(t, code)
		loads := 0
		loader := func() (map[string]any, error) {
			loads++
			token, err := issueMediaAccessToken(mediaKindArticle, 42)
			return map[string]any{"title": original["title"], "contentMd": original["contentMd"], "mediaAccessToken": token}, err
		}
		read := func() map[string]any {
			t.Helper()
			response, err := readCachedPublicShareDetail(code, loader)
			if err != nil {
				t.Fatal(err)
			}
			return response
		}

		time.Sleep(mediaTokenTTL - publicMediaTokenRenewBefore - time.Second)
		if response := read(); response["mediaAccessToken"] != original["mediaAccessToken"] || loads != 0 {
			t.Fatal("仍有足够有效期时应复用原缓存和凭证")
		}
		time.Sleep(time.Second)
		renewed := read()
		if loads != 1 || renewed["mediaAccessToken"] == original["mediaAccessToken"] {
			t.Fatal("临近过期应静默续期一次")
		}
		if next := read(); next["mediaAccessToken"] != renewed["mediaAccessToken"] || loads != 1 {
			t.Fatal("续期后的凭证应写回原缓存供后续请求复用")
		}

		// 模拟线上旧缓存：正文仍在 24 小时缓存期内，媒体凭证已经过期。
		time.Sleep(2 * time.Hour)
		if _, err := verifyMediaAccessToken(renewed["mediaAccessToken"].(string)); err == nil {
			t.Fatal("测试中的旧凭证应已过期")
		}
		response := read()
		claims, err := verifyMediaAccessToken(response["mediaAccessToken"].(string))
		if err != nil || claims.Kind != mediaKindArticle || claims.ID != 42 || loads != 2 {
			t.Fatalf("过期缓存应自动恢复为当前文章的有效凭证: %v", err)
		}
		if response["contentMd"] != original["contentMd"] {
			t.Fatal("续期不能改变文章展示内容")
		}
	})
}

func TestCachedShareDetailRenewalDoesNotBypassShareAccess(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const code = "revoked-cached-share"
		cachedShareDetailFixture(t, code)
		time.Sleep(2 * time.Hour)
		denied := forbiddenErr("该链接需要访问密码")
		_, err := readCachedPublicShareDetail(code, func() (map[string]any, error) {
			return nil, denied
		})
		if !errors.Is(err, denied) {
			t.Fatal("续期必须保留原有分享校验错误")
		}
		if _, ok := cache.GetRaw(sitecontent.ArticleDetailCacheKey(code)); ok {
			t.Fatal("校验失败后不能继续复用旧缓存")
		}
	})
}

func TestCachedShareDetailCoalescesConcurrentRenewals(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const code = "concurrent-cached-share"
		cachedShareDetailFixture(t, code)
		time.Sleep(2 * time.Hour)
		var loads atomic.Int32
		loader := func() (map[string]any, error) {
			loads.Add(1)
			time.Sleep(time.Second)
			token, err := issueMediaAccessToken(mediaKindArticle, 42)
			return map[string]any{"mediaAccessToken": token}, err
		}
		var requests sync.WaitGroup
		for range 12 {
			requests.Go(func() {
				response, err := readCachedPublicShareDetail(code, loader)
				if err != nil {
					t.Error(err)
					return
				}
				if _, err := verifyMediaAccessToken(response["mediaAccessToken"].(string)); err != nil {
					t.Error("并发请求应获得有效的新凭证")
				}
			})
		}
		requests.Wait()
		if loads.Load() != 1 {
			t.Fatalf("并发续期应合并为一次加载，实际 %d 次", loads.Load())
		}
	})
}
