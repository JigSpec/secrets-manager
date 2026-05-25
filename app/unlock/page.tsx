import { redirect } from "next/navigation";
import { isUnlocked, vaultIsInitialized, getSessionId } from "@/lib/vault/session";
import { UnlockForm } from "./unlock-form";

export const dynamic = "force-dynamic";

export default async function UnlockPage() {
  if (await isUnlocked()) {
    redirect("/");
  }
  const exists = await vaultIsInitialized();
  const sid = await getSessionId();
  const hasStaleSession = sid !== null;
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <UnlockForm mode={exists ? "unlock" : "create"} hasStaleSession={hasStaleSession} />
    </div>
  );
}
