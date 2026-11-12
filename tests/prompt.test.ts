import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readHidden } from '../src/cli';

/** 不回显地读密码：提示要留在屏幕上（readline 会把它擦掉） */

const fakeTty = () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(v: boolean) { this.isRaw = v; return this; } }) as unknown as NodeJS.ReadStream;
  const output = new PassThrough();
  let shown = '';
  output.on('data', (d) => { shown += d.toString(); });
  return { input, output, shown: () => shown };
};

describe('不回显地读一行', () => {
  it('提示原样留在屏幕上，输入不回显；退格、粘贴时的转义标记都处理好', async () => {
    const t = fakeTty();
    const p = readHidden('树洞密码：', t.input, t.output);
    t.input.write('my-secret\u007f\u007fXY');
    t.input.write('\u001b[200~粘贴\u001b[201~\r');
    expect(await p).toBe('my-secrXY粘贴');
    expect(t.shown()).toBe('树洞密码：\n');
    expect(t.input.isRaw).toBe(false);
  });

  it('什么都没输时 Ctrl+D 结束，返回空', async () => {
    const t = fakeTty();
    const p = readHidden('密码：', t.input, t.output);
    t.input.write('\u0004');
    expect(await p).toBe('');
  });
});
