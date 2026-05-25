-- 移除便签（sticky note）功能相关表。
-- 执行前请确认便签功能已从应用层下线，且相关历史数据不再需要保留。

drop index if exists petrichor_sticky_note_user_order_idx;

drop table if exists petrichor_sticky_note cascade;
