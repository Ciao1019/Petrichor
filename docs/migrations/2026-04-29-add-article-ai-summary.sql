alter table petrichor_kb_article
    add column if not exists ai_summary text,
    add column if not exists ai_summary_content_hash text,
    add column if not exists ai_summary_generated_at timestamptz;
