import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { toolMedia } from '@auto-agent/desktop-protocol';
import { readChatMedia, snapshotChatMedia } from '../../corax/lib/chat-media';
import { downloadChatImage } from '../../corax/lib/chat-image-download';

const base64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2XcAAAAASUVORK5CYII=';

test('attachment downloads follow same-origin redirects and stop before a different origin', async () => {
  let otherRequests = 0;
  const other = createServer((_request, response) => {
    otherRequests++;
    response.end();
  });
  const origin = createServer((request, response) => {
    const address = other.address();
    assert.ok(address && typeof address === 'object');
    if (request.url === '/same') response.writeHead(302, { Location: '/image' }).end();
    else if (request.url === '/other')
      response.writeHead(302, { Location: `http://127.0.0.1:${address.port}/image` }).end();
    else
      response.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.from(base64, 'base64'));
  });
  try {
    await Promise.all(
      [origin, other].map(
        (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
      ),
    );
    const address = origin.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await downloadChatImage(`${url}/same`, 1024)).bytes.toString('base64'), base64);
    await assert.rejects(downloadChatImage(`${url}/other`, 1024), /其他来源/);
    assert.equal(otherRequests, 0);
  } finally {
    origin.close();
    other.close();
  }
});

test('native read_file image remains tied to the recorded file type, size, and dimensions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-agent-media-'));
  try {
    const path = join(dir, '等温线.png');
    const bytes = Buffer.from(base64, 'base64');
    await writeFile(path, bytes);
    const result = {
      path,
      file: { mediaType: 'image/png', width: 1, height: 1, size: bytes.length },
    };
    const [media] = toolMedia('read_file', result);
    assert.equal(media?.kind, 'file');
    if (media?.kind !== 'file') throw new Error('missing native file');
    const options = { dataDir: dir, id: 'event:0' };
    await snapshotChatMedia(dir, options.id, media);
    assert.deepEqual(await readChatMedia(media, options), { mediaType: 'image/png', base64 });
    assert.deepEqual(toolMedia('bash', result), []);
    await writeFile(path, 'changed');
    assert.deepEqual(await readChatMedia(media, options), { mediaType: 'image/png', base64 });
    await assert.rejects(readChatMedia(media, { ...options, id: 'legacy:0' }), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('typed outputs support MCP image data and a video resource without interpreting text as an attachment', () => {
  const result = toolMedia('producer', {
    content: [
      { type: 'text', text: '/tmp/plot.png' },
      { type: 'image', mimeType: 'image/png', data: base64 },
      { type: 'file-url', mediaType: 'video/mp4', url: 'http://127.0.0.1:1234/clip.mp4' },
      { type: 'file-url', mediaType: 'image/svg+xml', url: 'https://example.com/plot.svg' },
    ],
  });
  assert.deepEqual(
    result.map(({ kind, mediaType }) => [kind, mediaType]),
    [
      ['data', 'image/png'],
      ['url', 'video/mp4'],
    ],
  );
});
