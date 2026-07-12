// test-mark.js — Mark 对话核心真实 LLM 测试
// 跑法: OPENROUTER_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node test-mark.js
// 用哨兵 chatId（MARKTEST_*）,测完清 conversations 表。
process.env.SKIP_BOT_INIT = '1';
const idx = require('./index.js');
const mark = require('./lib/mark');

let pass = 0, fail = 0;
const t = (c, m) => c ? (pass++, console.log('  PASS:', m)) : (fail++, console.error('  FAIL:', m));
const deps = (name) => ({
  callOpenRouter: idx.callOpenRouter,
  productContext: 'Fanz ceiling fans: FS Series 563L, Grande L Series, AURA Series Compact, Inno 435L, Eco 435L, Smart Series. All DC motor, 10-year motor warranty.',
  brandVoiceText: null,
  senderName: name || 'Tester',
});

(async () => {
  if (!process.env.OPENROUTER_API_KEY) { console.error('need OPENROUTER_API_KEY'); process.exit(1); }

  console.log('\n[1] 单篇请求绝不误触整月 + 两轮内给出 title_draft');
  {
    const c = 'MARKTEST_1';
    const t1 = await mark.markTurn(c, '帮我准备明天的一个content', deps());
    console.log('  Mark#1:', t1.clean.slice(0, 140), '| action:', t1.action);
    t(t1.action !== 'plan_month', '单篇请求没有触发 plan_month');
    let draft = t1.action === 'title_draft' ? t1.data : null;
    if (!draft) {
      const t2 = await mark.markTurn(c, '产品帖，Grande L Series', deps());
      console.log('  Mark#2:', t2.clean.slice(0, 140), '| action:', t2.action);
      draft = t2.action === 'title_draft' ? t2.data : null;
    }
    t(!!draft && !!draft.title && !!draft.pillar, `两轮内产出 title_draft (${draft ? draft.title : 'none'})`);
    t(!draft || /[一-鿿]|Grande|Fanz|fan/i.test(draft.title), 'title 内容合理');
  }

  console.log('\n[2] 明确要整月 → plan_month');
  {
    const c = 'MARKTEST_2';
    const t1 = await mark.markTurn(c, '帮我排整个月的content计划', deps());
    console.log('  Mark:', t1.clean.slice(0, 120), '| action:', t1.action);
    t(t1.action === 'plan_month', '整月请求触发 plan_month');
  }

  console.log('\n[3] 粘贴修改稿 → 先确认再 set_copy');
  {
    const c = 'MARKTEST_3';
    mark.markNote(c, '[system note: full copy for "Grande L: Quiet Comfort" was sent to the user for button review (calendar row abc-123). If the user pastes an edited version, summarise the change, ask them to confirm final, then output set_copy.]');
    mark.setActiveRow(c, 'abc-123');
    const pasted = 'Experience true quiet comfort with the Fanz Grande L Series. Powerful DC motor, whisper-quiet operation, and a 10-year motor warranty you can trust. Perfect for Malaysian living rooms. Visit our showroom today and feel the difference.';
    mark.setLastPaste(c, pasted);
    const t1 = await mark.markTurn(c, `我改了一下文案：\n\n${pasted}`, deps());
    console.log('  Mark#1:', t1.clean.slice(0, 140), '| action:', t1.action);
    t(t1.action !== 'set_copy', '第一轮不直接落库（先确认）');
    const t2 = await mark.markTurn(c, '对，确认，就用这个', deps());
    console.log('  Mark#2:', t2.clean.slice(0, 140), '| action:', t2.action);
    t(t2.action === 'set_copy', '确认后输出 set_copy');
  }

  console.log('\n[4] 闲聊 → 无动作、友好、带方向');
  {
    const c = 'MARKTEST_4';
    const t1 = await mark.markTurn(c, 'hello, you there?', deps());
    console.log('  Mark:', t1.clean.slice(0, 140), '| action:', t1.action);
    t(t1.action === null, '闲聊无动作');
    t(t1.clean.length > 0 && t1.clean.length < 500, '回复简短');
  }

  // 清理哨兵对话记录
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const H = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
    for (const c of ['MARKTEST_1', 'MARKTEST_2', 'MARKTEST_3', 'MARKTEST_4']) {
      await fetch(`${process.env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/conversations?chat_id=eq.${c}`, { method: 'DELETE', headers: H });
    }
    const r = await fetch(`${process.env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/conversations?chat_id=like.MARKTEST_%25&select=id`, { headers: H });
    const rows = await r.json();
    t(Array.isArray(rows) && rows.length === 0, '哨兵对话记录已清干净');
  } else {
    console.log('  SKIP cleanup: no SUPABASE env');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
