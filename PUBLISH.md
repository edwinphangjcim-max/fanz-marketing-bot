# [5] 发布节点 Publish

## 原则
- 只有最后一脚（打 Meta API）用 DRYRUN 控制，其他全部真实
- DRYRUN 由环境变量 `DRYRUN` 控制（默认 true），post_id 加 `DRYRUN-` 前缀
- 不准假实现蔓延

## 1. lib/publish.js — 核心发布模块

```javascript
const DRY_RUN = process.env.DRYRUN !== 'false'; // 默认 true（安全，不会真发）

/**
 * 组装发布载荷
 * 全部真实逻辑：把 fb_content/ig_content/hashtags 组装成发布结构
 */
function assemblePostPayload(row) {
  return {
    topic: row.topic,
    pillar: row.pillar,
    facebook: { message: row.fb_content || '' },
    instagram: { caption: row.ig_content || '', hashtags: row.hashtags || '' },
    hashtags: row.hashtags,
  };
}

/**
 * 验证载荷完整性
 * 全部真实：检查三字段非空、无占位符
 */
function validatePublishPayload(payload) {
  const errors = [];
  if (!payload.facebook.message.trim()) errors.push('Facebook content is empty');
  if (!payload.instagram.caption.trim()) errors.push('Instagram caption is empty');
  if (!payload.instagram.hashtags.trim()) errors.push('Hashtags are empty');

  // 检查占位符
  const allText = [payload.facebook.message, payload.instagram.caption, payload.instagram.hashtags].join(' ');
  if (/{{|}}|TODO|lorem|ipsum/i.test(allText)) {
    errors.push('Publish payload contains placeholder text');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 执行发布
 * - DRY_RUN=true（默认）：只模拟，返回 DRYRUN- 前缀 post_id
 * - DRY_RUN=false：调用真实 Meta API（当前抛未实现错误，等接入凭据后）
 * 
 * dry-run 只限这一脚
 */
async function publishToSocial(row) {
  const payload = assemblePostPayload(row);
  const validation = validatePublishPayload(payload);
  if (!validation.valid) {
    throw new Error(`Cannot publish: ${validation.errors.join('; ')}`);
  }

  if (DRY_RUN) {
    return {
      post_id: `DRYRUN-${Date.now()}`,
      fb_post_id: null,
      ig_post_id: null,
      dry_run: true,
      payload,
    };
  }

  // 真实 Meta API 调用 —— 当前未接入，等凭据配置后实现
  throw new Error('Real Meta API publish not yet configured. Set DRYRUN=true or configure Meta credentials.');
}

module.exports = {
  assemblePostPayload,
  validatePublishPayload,
  publishToSocial,
  DRY_RUN,
};
```

## 2. index.js 改动

### 2a. 批准后显示发布按钮
将 approve callback 中清除键盘改为显示 "🚀 Publish" 按钮：
```javascript
reply_markup: {
  inline_keyboard: [
    [{ text: '🚀 Publish', callback_data: `publish_go:${rowId}` }],
  ],
},
```

### 2b. Publish callback 处理器
`bot.on('callback_query', ...)` 新增 `publish_go:{rowId}` 分支：

流程：
1. 读当前行（`getContentCalendar(rowId)`）
2. **幂等检查**：如果已有 post_id → 直接回答案 "Already published: {post_id}"
3. 状态检查：if status !== 'approved' → answer "Cannot publish — status is {status}"
4. 调用 `publishToSocial(row)` → 返回 result
5. 更新 DB：`updateContentCalendar(rowId, { post_id: result.post_id, status: 'published' })`
6. 编辑消息追加 "🚀 Published (dry-run: {result.post_id})" 并清键盘
7. 异常处理：失败时 answerCallbackQuery + console.error，不改变状态

### 2c. require
顶部添加：`const { publishToSocial } = require('./lib/publish');`

## 3. test-publish.js

测试断言（全部 require 生产代码）：
1. assemblePostPayload 正确组装 fb/ig/hashtags
2. assemblePostPayload 处理空字段
3. validatePublishPayload 验证非空内容通过
4. validatePublishPayload 空内容报错
5. validatePublishPayload 占位符报错
6. publishToSocial dry-run 返回 DRYRUN- 前缀的 post_id
7. publishToSocial dry-run 设置 dry_run=true
8. publishToSocial 执行完整的 assemble → validate → publish 链路
9. 幂等检查：重复调用同一行返回已有 post_id（需 mock row 有 post_id）
10. 状态检查：非 approved 状态报错

## 4. test-publish.sh

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")"
node test-publish.js
echo "All publish tests passed!"
```

## 不变更
- 不修改 state-machine.js（已有 approved → published）
- 不修改 supabase.js 基础 CRUD
- 不修改 copywriting.js / planning.js
- 不修改已有的 sendWithSplit / userMessage
- 不修改已有的 approve callback 逻辑（仅改键盘输出）

## 文件清单
- 新建: lib/publish.js
- 修改: index.js（require + approve 键盘改为 publish 按钮 + publish callback）
- 新建: test-publish.js
- 新建: test-publish.sh