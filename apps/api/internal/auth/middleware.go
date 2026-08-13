package auth

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const (
	contextUserKey    = "petrichor_user"
	contextSessionKey = "petrichor_session"
	contextTokenKey   = "petrichor_token"
)

func Middleware(svc *Service, cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := ExtractToken(c, cfg.SessionCookieName)
		u, session, err := svc.CurrentUser(c.Request.Context(), token)
		if err != nil {
			response.Fail(c, err)
			return
		}
		c.Set(contextUserKey, u)
		c.Set(contextSessionKey, session)
		c.Set(contextTokenKey, token)
		secure := cfg.IsProduction()
		c.SetSameSite(http.SameSiteLaxMode)
		c.SetCookie(cfg.SessionCookieName, token, int(cfg.SessionExpire.Seconds()), "/", "", secure, true)
		c.Next()
	}
}

func MustUser(c *gin.Context) *ent.User {
	v, ok := c.Get(contextUserKey)
	if !ok {
		panic("auth middleware missing user")
	}
	return v.(*ent.User)
}

func MustSession(c *gin.Context) *ent.AuthSession {
	v, ok := c.Get(contextSessionKey)
	if !ok {
		panic("auth middleware missing session")
	}
	return v.(*ent.AuthSession)
}
