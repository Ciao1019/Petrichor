-- 向量维度动态化：不再把 1024 写死在列类型里
--
-- 背景：pgvector 的 HNSW 索引要求列有声明维度（vector(N)），一旦写死，
-- 换一个输出维度不同的向量模型就得清空重建。
--
-- 做法：把向量列放宽为无约束的 `vector`，让不同维度的行共存；
-- 索引改成「每个实际用到的维度一条部分表达式索引」：
--
--     create index ... using hnsw ((embedding::vector(N)) vector_cosine_ops)
--     where vector_dims(embedding) = N
--
-- 查询侧带上 vector_dims(embedding) = N 过滤并做同样的转型即可命中索引
-- （跨维度做 <=> 本来就会被 pgvector 拒绝，这个过滤是必需的）。
-- 索引由应用在探测到新维度时自动创建，见 server/retrieval/vector-space.ts。
--
-- 存量向量不受影响：旧维度的行原样保留，只是会因为 embedding_dimensions
-- 对不上当前模型而被判定为待重算。
--
-- 前置：先执行 2026-08-15-rebuild-ai-model-config.sql（本脚本不依赖它，
-- 但 dimensions 列由那个脚本创建）。
-- 执行前请确认已备份，并确认连接的是目标库。

begin;

-- 1. 拆掉钉死维度的旧索引。必须先于 alter column，否则类型放宽后索引仍会
--    把维度锁在 1024，插入其它维度会报 "different vector dimensions"。
drop index if exists idx_petrichor_kb_wiki_tree_node_embedding;
drop index if exists idx_petrichor_agent_memory_embedding;
drop index if exists idx_petrichor_assistant_message_embedding;

-- 2. 放宽列类型。已有数据原样保留（vector(1024) 的值就是 1024 维的 vector）。
alter table petrichor_kb_wiki_tree_node alter column embedding type vector;
alter table petrichor_agent_memory alter column embedding type vector;
alter table petrichor_assistant_message_embedding alter column embedding type vector;

-- 3. 向量生命周期元数据。
--    只有 wiki_tree_node 需要：它是唯一有「补写 / 重算」流程的表。
--    assistant_message_embedding 是滚动的会话缓存，按维度过滤即可，过期条目自然淘汰；
--    agent_memory 的 embedding 列当前没有读写方。
--
--    维度相同不代表向量空间相同（两个模型都输出 1024 维时 vector_dims 挡不住），
--    所以换模型的判定要靠 model + dimensions + version 三者。
alter table petrichor_kb_wiki_tree_node
    add column if not exists embedding_status text not null default 'pending',
    add column if not exists embedding_model text,
    add column if not exists embedding_dimensions integer,
    add column if not exists embedding_version integer not null default 1,
    add column if not exists embedding_error text,
    add column if not exists embedding_updated_at timestamptz;

-- 4. 存量向量的元数据回填。
--    已有 embedding 的行标成 ready 并记下实际维度，但 embedding_model 留空——
--    我们无从得知它们是哪个模型写的。留空会让它们在下次绑定模型后被判定为待重算，
--    这是正确的保守行为：宁可重算，不要拿来源不明的向量做检索。
update petrichor_kb_wiki_tree_node
set embedding_status = 'ready',
    embedding_dimensions = vector_dims(embedding),
    embedding_updated_at = now()
where embedding is not null and embedding_status = 'pending';

-- 5. 为存量的 1024 维数据补建部分索引，避免迁移后检索退化为顺序扫描。
--    其它维度的索引由应用在探测到该维度时自动创建。
create index if not exists idx_petrichor_kb_wiki_tree_node_embedding_d1024
    on petrichor_kb_wiki_tree_node using hnsw ((embedding::vector(1024)) vector_cosine_ops)
    where vector_dims(embedding) = 1024;

create index if not exists idx_petrichor_agent_memory_embedding_d1024
    on petrichor_agent_memory using hnsw ((embedding::vector(1024)) vector_cosine_ops)
    where vector_dims(embedding) = 1024;

create index if not exists idx_petrichor_assistant_message_embedding_d1024
    on petrichor_assistant_message_embedding using hnsw ((embedding::vector(1024)) vector_cosine_ops)
    where vector_dims(embedding) = 1024;

commit;
