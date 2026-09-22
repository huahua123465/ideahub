/**
 * 聊天面板「AI 助手」专项验收：npm run test:ai-chat:ui
 *
 * 跑在内置演示数据上（mock.js 里 /api/ai-chat* 那几条），桌面和手机各走一遍：
 *   打开聊天 → 进入 AI 助手 → 提问看到「正在回答」再看到回答 → 刷新后记录还在
 *   → 管理员打开接入设置：拉取模型、保存 → 清空对话
 * 同时检查页面级横向溢出、弹窗在视口内、浏览器报错和越界请求。
 * 截图和 report.json 写到 scripts/.uidiff/ai-chat/。
 */
import assert from 'node:assert/strict';
import { createUiHarness, settleDom } from './lib/ui-harness.mjs';

const harness = await createUiHarness({ outputDir: 'scripts/.uidiff/ai-chat' });

const overflow = page => page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function inViewport(page, sel) {
  const r = await page.$eval(sel, el => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: innerWidth, h: innerHeight };
  });
  assert.ok(r.left >= -1 && r.top >= -1 && r.right <= r.w + 1 && r.bottom <= r.h + 1,
    `${sel} 超出视口：${JSON.stringify(r)}`);
}

/** 按钮中心点上最顶层的元素就是它自己 —— 被聊天面板盖住的按钮点不到 */
async function onTop(page, sel) {
  const ok = await page.$eval(sel, el => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
  assert.ok(ok, `${sel} 被别的元素盖住了`);
}

async function openAi(page) {
  await page.click('#chatBtn');
  await page.waitForSelector('#chatList .peer-ai', { visible: true });
  await page.click('#chatList .peer-ai');
  await page.waitForFunction(() => document.querySelector('#chatTitle')?.textContent === 'AI 助手'
    && !document.querySelector('#chatMsgs')?.textContent.includes('正在读取'));
  await settleDom(page);
}

try {
  for (const [scene, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ]) {
    const page = await harness.newPage(scene, viewport);
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* 无痕 */ } });
    await openAi(page);

    let st = await page.evaluate(() => ({
      empty: document.querySelector('#chatMsgs .ai-empty')?.textContent || '',
      clipHidden: document.querySelector('#chatFoot .chatclip')?.hidden,
      setupVisible: !document.querySelector('#chatAiSetup')?.hidden,
      clearHidden: document.querySelector('#chatAiClear')?.hidden,
      placeholder: document.querySelector('#chatInput')?.placeholder,
    }));
    assert.match(st.empty, /有什么可以帮你/, JSON.stringify(st));
    assert.equal(st.clipHidden, true, 'AI 会话不应该出现发文件');
    assert.equal(st.setupVisible, true, '管理员应该看到接入设置');
    assert.equal(st.clearHidden, true, '没有记录时不显示清空');
    assert.match(st.placeholder, /问 AI/);

    // 提问：先看到正在回答，再看到回答；等待期间发送按钮不可用
    await page.type('#chatInput', '帮我想一个周会的议程');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#chatMsgs .ai-typing', { visible: true });
    assert.equal(await page.$eval('#chatSend', b => b.disabled), true, '回答期间发送按钮应禁用');
    await page.waitForFunction(() => document.querySelector('#chatMsgs .msg-ai .bubble')?.textContent.includes('演示回答'));
    st = await page.evaluate(() => ({
      mine: document.querySelectorAll('#chatMsgs .msg.mine').length,
      ai: document.querySelectorAll('#chatMsgs .msg-ai').length,
      bold: document.querySelector('#chatMsgs .msg-ai b')?.textContent,
      input: document.querySelector('#chatInput').value,
      sendDisabled: document.querySelector('#chatSend').disabled,
      preview: document.querySelector('#chatList .peer-ai .peer-last')?.textContent,
      clearHidden: document.querySelector('#chatAiClear')?.hidden,
    }));
    assert.deepEqual([st.mine, st.ai], [1, 1], JSON.stringify(st));
    assert.equal(st.bold, '建议', '回答里的 **粗体** 应该排版出来');
    assert.equal(st.input, '');
    assert.equal(st.sendDisabled, false);
    assert.match(st.preview, /演示回答/);
    assert.equal(st.clearHidden, false);
    assert.ok(await overflow(page) <= 1, '页面横向溢出');
    await inViewport(page, '#chatPanel');
    await harness.screenshot(page, `ai-chat-answer-${scene}`);

    // 刷新后记录还在（存在浏览器里）
    await page.reload({ waitUntil: 'networkidle0' });
    await openAi(page);
    const kept = await page.$$eval('#chatMsgs .msg', n => n.length);
    assert.equal(kept, 2, '刷新后 AI 对话应该还在');

    // 管理员接入设置：拉取模型 → 保存
    await page.click('#chatAiSetup');
    await page.waitForSelector('#aiSetupModal.on', { visible: true });
    await page.waitForFunction(() => /当前/.test(document.querySelector('#aiSetupNow').textContent)
      && !/正在读取/.test(document.querySelector('#aiSetupNow').textContent));
    assert.equal(await page.$eval('#aiSetupSave', b => b.disabled), true, '没拉模型前不能保存');
    await onTop(page, '#aiSetupFetch');
    await page.click('#aiSetupFetch');
    await page.waitForFunction(() => document.querySelectorAll('#aiSetupModel option').length === 3
      && /连接成功/.test(document.querySelector('#aiSetupFeedback').textContent));
    await page.select('#aiSetupModel', 'deepseek-chat');
    await settleDom(page);
    await inViewport(page, '#aiSetupModal');
    assert.ok(await overflow(page) <= 1, '接入弹窗横向溢出');
    await harness.screenshot(page, `ai-chat-setup-${scene}`);
    await page.click('#aiSetupSave');
    await page.waitForFunction(() => !document.querySelector('#aiSetupModal.on'));
    assert.equal(await page.evaluate(() => document.querySelector('#chatPanel').classList.contains('on')), true,
      '保存接入后聊天面板不应被收起');

    // 改地址会让已拉的模型作废
    await page.click('#chatAiSetup');
    await page.waitForSelector('#aiSetupModal.on', { visible: true });
    await page.waitForFunction(() => !document.querySelector('#aiSetupReset').hidden);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#aiSetupModal.on'));

    // 清空对话
    await page.click('#chatAiClear');
    await page.waitForSelector('#confirmSubmit', { visible: true });
    await page.click('#confirmSubmit');
    await page.waitForFunction(() => document.querySelector('#chatMsgs .ai-empty')
      && !document.querySelector('#chatMsgs .msg'));
    const stored = await page.evaluate(() => Object.keys(localStorage)
      .filter(k => k.startsWith('ideahub.aiChat.')).map(k => localStorage.getItem(k)));
    assert.ok(stored.every(v => v === '[]'), `清空后本地记录应为空：${stored}`);

    // 手机上「返回」回到列表
    if (scene === 'mobile') {
      await page.click('#chatBack');
      await page.waitForSelector('#chatList .peer-ai', { visible: true });
    }

    // 建群弹窗同样要压在聊天面板上面
    await page.waitForSelector('#chatNewGroup', { visible: true });
    await page.click('#chatNewGroup');
    await page.waitForSelector('#groupModal.on', { visible: true });
    await settleDom(page);
    await onTop(page, '#groupOk');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#groupModal.on'));

    harness.recordCheck(`${scene}-ai-chat-flow`, 'interaction', { asked: true, persisted: true, setup: true, cleared: true });
    await page.close();
  }

  assert.deepEqual(harness.report.browserErrors, [], JSON.stringify(harness.report.browserErrors));
  assert.deepEqual(harness.report.networkErrors, [], JSON.stringify(harness.report.networkErrors));
  await harness.writeReport();
  console.log(`AI 助手验收通过：${harness.report.checks.length} 项检查，${harness.report.screenshots.length} 张截图`);
} catch (error) {
  await harness.writeReport(error);
  throw error;
} finally {
  await harness.close();
}
