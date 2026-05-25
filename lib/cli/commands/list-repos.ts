import { register } from "../router";
import { sendCommand } from "../ipc-client";

register("list-repos", async () => {
  return sendCommand({ cmd: "list-repos" });
});
