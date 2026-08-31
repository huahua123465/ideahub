import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { IDEA_FILE_EXT,MAX_IDEA_FILES,ideaUploadParams } from '../server/src/routes/files.mjs';

test('灵感附件只允许PDF、Word和Excel且上限固定',()=>{
  assert.deepEqual([...IDEA_FILE_EXT],['.pdf','.doc','.docx','.xls','.xlsx']);
  assert.equal(MAX_IDEA_FILES,8);
  for(const name of ['方案.pdf','需求.doc','复盘.docx','数据.xls','预算.xlsx']){
    const params=ideaUploadParams(new URL(`http://local.test/?name=${encodeURIComponent(name)}`));
    assert.equal(params.origName,name);
  }
  for(const name of ['图片.png','脚本.html','数据.csv','无扩展名']){
    assert.throws(()=>ideaUploadParams(new URL(`http://local.test/?name=${encodeURIComponent(name)}`)),
      /灵感附件只支持|不支持这个格式/);
  }
});

test('灵感附件路由包含权限、匿名保护、下载校验和永久清理',async()=>{
  const [files,ideas,dto,purge,modal,drawer,index]=await Promise.all([
    readFile(new URL('../server/src/routes/files.mjs',import.meta.url),'utf8'),
    readFile(new URL('../server/src/routes/ideas.mjs',import.meta.url),'utf8'),
    readFile(new URL('../server/src/lib/dto.mjs',import.meta.url),'utf8'),
    readFile(new URL('../server/src/lib/purge.mjs',import.meta.url),'utf8'),
    readFile(new URL('../web/src/views/modal.js',import.meta.url),'utf8'),
    readFile(new URL('../web/src/views/drawer.js',import.meta.url),'utf8'),
    readFile(new URL('../web/index.html',import.meta.url),'utf8'),
  ]);
  assert.match(files,/\/api\/ideas\/:id\/files/);
  assert.match(files,/只有灵感作者本人和管理员能上传附件/);
  assert.match(files,/idea\.is_anonymous\?null/);
  assert.match(files,/f\.scope==='idea'/);
  assert.match(ideas,/scope:'idea'/);
  assert.match(ideas,/canManageFiles/);
  assert.match(dto,/file_count/);
  assert.match(purge,/attachments WHERE scope/);
  assert.match(index,/accept="\.pdf,\.doc,\.docx,\.xls,\.xlsx"/);
  assert.match(modal,/上传附件 \$\{index\+1\}/);
  assert.match(drawer,/ideaFileUpload/);
});
