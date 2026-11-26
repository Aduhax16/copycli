import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyChatUpdate, chatSummary, organizeChats } from '../src/shared/chats.js';
import { Store } from '../src/main/store.js';
import { Orchestrator } from '../src/main/orchestrator.js';
const c = (id, extra = {}) => ({ id, title: id, cwd: '/work/project', updated: 1, messages: [], ...extra });
test('chat organization is saved and reloads without changing conversation content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copycli-chats-'));
  try {
    const store = new Store(dir), chat = c('one', { messages: [{ role: 'user', text: 'Original task' }] });
    store.chats.set(chat.id, chat);
    applyChatUpdate(chat, { title: '  Final project  ', group: '  University   work ', pinned: true, archived: true });
    store.save(chat); store.flushAll();
    const loaded = new Store(dir).chats.get(chat.id);
    assert.equal(loaded.title, 'Final project');
    assert.equal(loaded.group, 'University work');
    assert.equal(loaded.pinned, true); assert.equal(loaded.archived, true);
    assert.deepEqual(loaded.messages, [{ role: 'user', text: 'Original task' }]);
    applyChatUpdate(loaded, { archived: false });
    assert.equal(loaded.pinned, true); assert.equal(loaded.group, 'University work');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('renaming rejects empty input and metadata updates cannot overwrite messages or folders', () => {
  const chat = c('one');
  assert.throws(() => applyChatUpdate(chat, { title: '   ' }), /name/);
  applyChatUpdate(chat, { title: 'a'.repeat(100), group: 'b'.repeat(90), messages: [], cwd: '/other', pinned: 'true' });
  assert.equal(chat.title.length, 80); assert.equal(chat.group.length, 60);
  assert.equal(chat.cwd, '/work/project'); assert.equal(chat.pinned, undefined);
  assert.equal(chat.customTitle, true);
  assert.deepEqual(chatSummary(c('legacy'), true), { id: 'legacy', title: 'legacy', cwd: '/work/project', updated: 1, running: true, pinned: false, archived: false, group: '' });
});
test('pinned chats appear once, groups are sorted, recent chats follow activity', () => {
  const chats = [c('old'), c('new', { updated: 50 }), c('pin', { pinned: true, group: 'Work' }), c('z', { group: 'Zebra' }), c('a', { group: 'Alpha' }), c('archived', { archived: true, pinned: true })];
  const sections = organizeChats(chats);
  assert.deepEqual(sections.map((x) => x.label), ['Pinned', 'Alpha', 'Zebra', 'Recent']);
  assert.deepEqual(sections.at(-1).chats.map((x) => x.id), ['new', 'old']);
  assert.equal(sections.flatMap((x) => x.chats).length, 5);
  assert.deepEqual(organizeChats(chats, { archived: true }).flatMap((x) => x.chats).map((x) => x.id), ['archived']);
  assert.deepEqual(chats.map((x) => x.id), ['old', 'new', 'pin', 'z', 'a', 'archived']);
});
test('search finds names, folders and groups, including accents; archive remains separate', () => {
  const chats = [c('one', { title: 'Revisión del diseño' }), c('two', { group: 'University' }), c('three', { cwd: '/work/copycli' }), c('four', { title: 'CopyCLI', archived: true })];
  const ids = (query, archived = false) => organizeChats(chats, { query, archived }).flatMap((x) => x.chats).map((x) => x.id);
  assert.deepEqual(ids('revision'), ['one']);
  assert.deepEqual(ids('UNIVERSITY'), ['two']);
  assert.deepEqual(ids('copycli'), ['three']);
  assert.deepEqual(ids('copycli', true), ['four']);
  assert.deepEqual(ids('missing'), []);
});

test('chat update API exposes organization metadata in the sidebar summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copycli-chat-api-'));
  try {
    const store = new Store(dir), o = new Orchestrator({ store, emit() {}, detector: async () => ({ installed: false }) });
    const chat = o.createChat({ cwd: '/work' });
    o.updateChat(chat.id, { title: 'New chat', group: 'University', pinned: true, archived: true });
    const summary = o.listChats().find((x) => x.id === chat.id);
    assert.deepEqual([summary.title, summary.group, summary.pinned, summary.archived], ['New chat', 'University', true, true]);
    assert.equal(chat.customTitle, true, 'an explicitly chosen name is not an automatic placeholder');
    store.flushAll();
    assert.equal(new Store(dir).chats.get(chat.id).group, 'University');
    assert.throws(() => o.updateChat(chat.id, { title: '  ' }), /name/);
    assert.equal(chat.title, 'New chat');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
