import { registerHandler, currentSessionData } from "../server";
import { ok } from "../protocol";

registerHandler("list-repos", async () => {
  const { data } = currentSessionData();
  return ok({
    repos: data.repos.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      environments: r.environments,
    })),
  });
});
