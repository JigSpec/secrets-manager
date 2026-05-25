import { register } from "../router";
import { sendCommand } from "../ipc-client";

register("find-shared", async () => {
  return sendCommand({ cmd: "find-shared" });
});
