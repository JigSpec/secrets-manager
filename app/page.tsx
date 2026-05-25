import { redirect } from "next/navigation";
import {
  getVaultData,
  isUnlocked,
  vaultIsInitialized,
} from "@/lib/vault/session";
import { Workbench } from "@/components/workbench";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await vaultIsInitialized())) {
    redirect("/unlock");
  }
  if (!(await isUnlocked())) {
    redirect("/unlock");
  }
  const data = await getVaultData();
  if (!data) {
    redirect("/unlock");
  }
  return <Workbench initialData={data} />;
}
