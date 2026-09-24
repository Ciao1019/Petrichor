-- +goose Up
-- 删除采集记录采用逻辑删除，保留计费计数、幂等标识及其他快照复用的附件。
ALTER TABLE public.petrichor_inbox_capture ADD COLUMN deleted_at timestamptz;
