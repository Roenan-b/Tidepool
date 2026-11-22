/** Reads a line from the terminal without echoing it. */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error('no terminal available for an interactive prompt'));
  return new Promise((resolvePromise, reject) => {
    const chars: string[] = [];
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) {
        chars.length = 0;
        reject(err);
      } else {
        const value = chars.join('');
        chars.length = 0;
        resolvePromise(value);
      }
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') chars.pop();
        else chars.push(ch);
      }
    };
    stdin.on('data', onData);
  });
}
