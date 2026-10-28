#!/usr/bin/env node

async function main() {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (
    !['profiles', 'inspect', 'compare', 'create', 'modify', 'save-as'].includes(command) ||
    !argument ||
    extra.length
  )
    throw Object.assign(
      new Error(
        '使用 profiles、inspect、compare、create、modify 或 save-as，并传入一个 JSON 参数。',
      ),
      {
        publicCode: 'INVALID_COMMAND',
      },
    );
  if (Buffer.byteLength(argument) > 16384)
    throw Object.assign(new Error('JSON 参数超过 16384 字节。'), { publicCode: 'INVALID_INPUT' });
  let input;
  try {
    input = JSON.parse(argument);
  } catch {
    throw Object.assign(new Error('参数不是有效 JSON。'), { publicCode: 'INVALID_INPUT' });
  }
  const { inspectSam } = await import('./lib/sam.js');
  const result =
    command === 'profiles'
      ? await (await import('./lib/sam-generate.js')).samProfiles(input)
      : ['inspect', 'compare'].includes(command)
        ? await inspectSam(input, command)
        : await (await import('./lib/sam-write.js')).writeSam(input, command);
  console.log(JSON.stringify(result));
}
main().catch((error) => {
  console.log(
    JSON.stringify({
      error: {
        code: error.publicCode ?? 'FILE_OPERATION_FAILED',
        message: error.publicCode
          ? error.message
          : '模板文件操作失败；写入操作请先核对目标文件，不自动重试。',
      },
    }),
  );
  process.exitCode = 1;
});
