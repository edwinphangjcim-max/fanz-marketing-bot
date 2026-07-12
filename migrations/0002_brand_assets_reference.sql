-- ============================================================
-- 0002_brand_assets_reference.sql
--
-- 放宽 brand_assets.kind 的 CHECK 约束，允许 'reference'。
--
-- 用途：让品牌管理员把过去的设计成品（海报、广告图等）上传为
-- kind='reference'，管线在生成背景 prompt 前用视觉模型分析这些
-- 参考图的共同风格（色彩、光线、构图、氛围），注入 STYLE REFERENCE
-- 段，让每次 AI 生图更贴近品牌历史视觉语言，而不是只靠
-- background_style 文字描述。
--
-- 操作：先 DROP 旧约束，再 ADD 新约束（PostgreSQL 不支持 ALTER CHECK）。
-- ============================================================

alter table brand_assets
  drop constraint if exists brand_assets_kind_check;

alter table brand_assets
  add constraint brand_assets_kind_check
  check (kind in ('product', 'logo', 'photo', 'reference'));
