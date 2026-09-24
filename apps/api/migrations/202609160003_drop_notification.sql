-- +goose Up

-- 消息中心已下线，删除通知表及全部历史消息。
-- PostgreSQL 会同时删除该表的索引、约束和归属它的自增序列，不影响用户与文章数据。
DROP TABLE IF EXISTS public.petrichor_notification;
