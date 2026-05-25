/**
 * Read a master password from the controlling TTY without echoing.
 * If stdin is not a TTY (CI / test harness piping the password in), read
 * one line of stdin verbatim and return it — this is the documented test
 * mode and is not used interactively.
 *
 * NEVER logs the password.
 */
export async function readPasswordFromTty(
  prompt = "vault password: ",
): Promise<string> {
  if (!process.stdin.isTTY) {
    return readSingleLineFromStdin();
  }
  return new Promise<string>((resolve, reject) => {
    process.stderr.write(prompt);
    const stdin = process.stdin as NodeJS.ReadStream & {
      setRawMode?: (mode: boolean) => void;
    };
    const wasRaw = stdin.isRaw === true;
    try {
      stdin.setRawMode?.(true);
    } catch (e) {
      reject(e);
      return;
    }
    let pw = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          stdin.removeListener("data", onData);
          try {
            stdin.setRawMode?.(wasRaw);
          } catch {
            // ignore
          }
          stdin.pause();
          stdin.unref();
          process.stderr.write("\n");
          resolve(pw);
          return;
        }
        if (ch === "\x03") {
          // ctrl-c
          stdin.removeListener("data", onData);
          try {
            stdin.setRawMode?.(false);
          } catch {
            // ignore
          }
          stdin.pause();
          stdin.unref();
          reject(new Error("interrupted"));
          return;
        }
        if (code === 0x7f || code === 0x08) {
          // backspace
          pw = pw.slice(0, -1);
          continue;
        }
        pw += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function readSingleLineFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        process.stdin.removeListener("error", onErr);
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = () => {
      resolve(buf);
    };
    const onErr = (e: Error) => {
      reject(e);
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onErr);
  });
}
