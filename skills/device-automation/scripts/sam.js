#!/usr/bin/env node

async function main() {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (!['inspect', 'compare'].includes(command) || !argument || extra.length)
    throw Object.assign(new Error('使用 inspect 或 compare，并传入一个 JSON 参数。'), {
      publicCode: 'INVALID_COMMAND',
    });
  if (Buffer.byteLength(argument) > 16384)
    throw Object.assign(new Error('JSON 参数超过 16384 字节。'), { publicCode: 'INVALID_INPUT' });
  let input;
  try {
    input = JSON.parse(argument);
  } catch {
    throw Object.assign(new Error('参数不是有效 JSON。'), { publicCode: 'INVALID_INPUT' });
  }
  const { inspectSam } = await import('./lib/sam.js');
  console.log(JSON.stringify(await inspectSam(input, command)));
}
main().catch((error) => {
  console.log(
    JSON.stringify({
      error: {
        code: error.publicCode ?? 'FILE_READ_FAILED',
        message: error.publicCode ? error.message : '无法读取或解析所指定的模板文件。',
      },
    }),
  );
  process.exitCode = 1;
});
