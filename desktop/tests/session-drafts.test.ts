import { expect, test } from 'bun:test';
import { SessionDrafts } from '../src/lib/session-drafts';

test('new and existing sessions retain independent unsent text', () => {
  const drafts = new SessionDrafts();
  drafts.set('', 'new conversation');
  drafts.set('one', 'first session');
  drafts.set('two', 'second session');
  expect(drafts.read('one')).toBe('first session');
  expect(drafts.read('two')).toBe('second session');
  expect(drafts.read('')).toBe('new conversation');
  expect(drafts.read('unopened')).toBe('');
});

test('an accepted send clears only its unchanged originating draft', () => {
  const drafts = new SessionDrafts();
  drafts.set('one', 'sent');
  const submitted = drafts.capture('one');
  drafts.set('two', 'never sent');
  expect(drafts.accepted('one', submitted, 'sent')).toBe(true);
  expect(drafts.read('one')).toBe('');
  expect(drafts.read('two')).toBe('never sent');
  drafts.set('one', 'sent');
  expect(drafts.accepted('one', submitted, 'sent')).toBe(false);
  const second = drafts.capture('one');
  drafts.set('one', 'next');
  drafts.set('one', 'sent');
  expect(drafts.accepted('one', second, 'sent')).toBe(false);
  expect(drafts.read('one')).toBe('sent');
  const unchangedText = drafts.capture('one');
  drafts.set('one', 'sent');
  expect(drafts.accepted('one', unchangedText, 'sent')).toBe(false);
});

test('session creation transfers edits without letting an old receipt erase them', () => {
  const drafts = new SessionDrafts();
  drafts.set('', 'submitted');
  const submitted = drafts.capture('');
  drafts.set('', 'edited during creation');
  drafts.attach('created');
  expect(drafts.read('')).toBe('');
  expect(drafts.read('created')).toBe('edited during creation');
  expect(drafts.accepted('created', submitted, 'submitted')).toBe(false);
});

test('a detached creation cannot take a newer new-conversation draft', () => {
  const drafts = new SessionDrafts();
  drafts.set('', 'original submission');
  const submitted = drafts.capture('');
  drafts.set('', 'separate new draft');
  drafts.attach('created', submitted);
  expect(drafts.read('')).toBe('separate new draft');
  expect(drafts.accepted('created', submitted, 'original submission')).toBe(true);
  expect(drafts.read('')).toBe('separate new draft');
});

test('sending a recommendation does not consume unrelated typed text', () => {
  const drafts = new SessionDrafts();
  drafts.set('', 'typed question');
  const submitted = drafts.capture('');
  drafts.attach('created');
  expect(drafts.accepted('created', submitted, 'recommended question')).toBe(false);
  expect(drafts.read('created')).toBe('typed question');
  expect(drafts.read('')).toBe('');
});
