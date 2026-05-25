import { registerHandler, currentSessionData } from "../server";
import { ok } from "../protocol";
import { findShared } from "../../import/shared-finder";

registerHandler("find-shared", async () => {
  const { data } = currentSessionData();
  const groups = findShared(data.secrets);
  return ok({ groups });
});
