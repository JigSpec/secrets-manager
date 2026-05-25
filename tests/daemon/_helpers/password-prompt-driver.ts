import { readPasswordFromTty } from "../../../lib/daemon/password-prompt";
readPasswordFromTty()
  .then((pw) => {
    process.stdout.write(pw + "\n");
  })
  .catch((err) => { process.stderr.write(String(err) + "\n"); process.exit(1); });
