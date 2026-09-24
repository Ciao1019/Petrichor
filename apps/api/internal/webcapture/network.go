package webcapture

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func blocked(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "64:ff9b::/96", "2002::/16"} {
		_, n, _ := net.ParseCIDR(block)
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ParseURL 保留有意义的 query，仅去掉 fragment；不接收凭据和非公开协议。
func ParseURL(raw string) (*url.URL, error) {
	u, e := url.Parse(strings.TrimSpace(raw))
	if e != nil || len(raw) > 4096 || u.Hostname() == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("请输入公开的 HTTP(S) 网页地址")
	}
	h := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if (net.ParseIP(h) == nil && !strings.Contains(h, ".")) || h == "localhost" || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") || strings.HasPrefix(h, "metadata.") {
		return nil, errors.New("不支持内网网页地址")
	}
	if ip := net.ParseIP(h); ip != nil && blocked(ip) {
		return nil, errors.New("不支持内网网页地址")
	}
	u.Fragment = ""
	return u, nil
}
func ValidateURL(ctx context.Context, raw string) (*url.URL, error) {
	u, e := ParseURL(raw)
	if e != nil {
		return nil, e
	}
	ips, e := net.DefaultResolver.LookupIPAddr(ctx, u.Hostname())
	if e != nil || len(ips) == 0 {
		return nil, errors.New("网页域名无法解析")
	}
	for _, ip := range ips {
		if blocked(ip.IP) {
			return nil, errors.New("网页域名指向非公网地址")
		}
	}
	return u, nil
}

// 下载媒体时在连接阶段再次检查并直接连接已校验的 IP，防止 DNS 重绑定。
func PublicClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: nil, ResponseHeaderTimeout: 15 * time.Second, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		for _, ip := range ips {
			if blocked(ip.IP) {
				return nil, errors.New("非公网目标")
			}
		}
		for _, ip := range ips {
			conn, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if err == nil {
				return conn, nil
			}
		}
		return nil, errors.New("媒体连接失败")
	}}, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("重定向次数过多")
		}
		_, e := ValidateURL(req.Context(), req.URL.String())
		return e
	}}
}
