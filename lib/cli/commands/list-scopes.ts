import { register } from "../router";
import { sendCommand } from "../ipc-client";

register("list-scopes", async () => {
  return sendCommand({ cmd: "list-scopes" });
});
