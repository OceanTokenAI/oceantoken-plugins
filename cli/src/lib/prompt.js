import readline from "node:readline";

/** Ask for a secret on the terminal without echoing what is typed or pasted. */
export function promptHidden(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) output.write(question);
    };
    rl.question(question, (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    });
  });
}

/** Ask a yes/no question on the terminal; anything but y / yes is no. */
export function promptYesNo(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    });
  });
}

/** Open a URL in the default browser; false when there is no way to. */
export async function openUrl(url, runner, platform = process.platform) {
  const [cmd, args] =
    platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    return (await runner(cmd, args, {})).code === 0;
  } catch {
    return false;
  }
}
