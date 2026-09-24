-- +goose Up
-- 随笔复用文章编辑器，保留 Markdown 无法表达的排版和批注；旧记录继续从 Markdown 读取。
ALTER TABLE public.petrichor_inbox_note
    ADD COLUMN content_json text,
    ADD COLUMN content_meta_json text;
