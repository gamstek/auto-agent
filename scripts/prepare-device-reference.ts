/** Developer asset maintenance only. Never accepts a user database or ingests through a model. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rename, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'skills/device-automation/assets/library.sqlite');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function evidence(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const docs = db
      .prepare(
        "SELECT d.*,v.sha256 AS sourceHash,r.parserId,r.parserVersion,r.attributes,r.issues,r.unitCount FROM documents d JOIN versions v ON v.id=d.versionId JOIN representations r ON r.id=d.representationId WHERE r.parserId='sam.reference' ORDER BY d.id",
      )
      .all();
    const index = new Map(
      db
        .prepare('SELECT unitId,body FROM wiki_fts')
        .all()
        .map((row) => [row.unitId, row.body]),
    );
    const hash = createHash('sha256');
    for (const doc of docs) {
      hash.update(JSON.stringify(doc));
      for (const row of db
        .prepare('SELECT * FROM units WHERE representationId=? ORDER BY ordinal')
        .iterate(doc.representationId as string))
        hash.update(JSON.stringify({ ...row, indexed: index.get(row.id) }));
    }
    return { documents: docs.length, sha256: hash.digest('hex') };
  } finally {
    db.close();
  }
}
const beforeBytes = digest(await readFile(output));
const before = evidence(output);
const temporary = await mkdtemp(join(root, 'skills/device-automation/assets/.prepare-'));
try {
  const staged = join(temporary, 'library.sqlite');
  await copyFile(output, staged);
  const db = new DatabaseSync(staged);
  try {
    if (db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok')
      throw new Error('内置参考完整性检查失败');
    db.exec(`BEGIN IMMEDIATE;
      DELETE FROM wiki_fts WHERE unitId IN (SELECT u.id FROM units u JOIN representations r ON r.id=u.representationId JOIN versions v ON v.id=r.versionId JOIN documents d ON d.id=v.documentId WHERE d.sourceId='builtin-guidance');
      DELETE FROM units WHERE representationId IN (SELECT r.id FROM representations r JOIN versions v ON v.id=r.versionId JOIN documents d ON d.id=v.documentId WHERE d.sourceId='builtin-guidance');
      DELETE FROM representations WHERE versionId IN (SELECT v.id FROM versions v JOIN documents d ON d.id=v.documentId WHERE d.sourceId='builtin-guidance');
      DELETE FROM versions WHERE documentId IN (SELECT id FROM documents WHERE sourceId='builtin-guidance');
      DELETE FROM documents WHERE sourceId='builtin-guidance';
      DELETE FROM sources WHERE id='builtin-guidance';
      COMMIT; VACUUM;`);
  } finally {
    db.close();
  }
  if (JSON.stringify(evidence(staged)) !== JSON.stringify(before))
    throw new Error('历史 SAM 证据发生变化，未发布');
  if (digest(await readFile(output)) !== beforeBytes)
    throw new Error('目标参考库在处理期间发生变化');
  await rename(staged, output);
  const guides = {} as Record<string, string>;
  for (const name of ['选择规则', '模板定义'])
    guides[name] = digest(
      await readFile(join(root, `skills/device-automation/references/materials/${name}.md`)),
    );
  console.log(
    JSON.stringify(
      { ...before, verified: true, guidance: guides, assetSha256: digest(await readFile(output)) },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
