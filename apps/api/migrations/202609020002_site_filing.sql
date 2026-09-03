-- +goose Up

-- 站点备案信息为单例配置；默认关闭，不影响未配置站点的前台展示。
CREATE TABLE public.petrichor_site_filing (
    id integer PRIMARY KEY,
    enabled boolean DEFAULT false NOT NULL,
    icp_number text DEFAULT ''::text NOT NULL,
    icp_url text DEFAULT 'https://beian.miit.gov.cn/'::text NOT NULL,
    public_security_number text DEFAULT ''::text NOT NULL,
    public_security_url text DEFAULT 'https://www.beian.gov.cn/portal/registerSystemInfo'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- +goose Down

DROP TABLE public.petrichor_site_filing;
