import { redirect } from "next/navigation";

// The PBX settings moved under Admin; keeps old bookmarks working.
export default function OldPbxPage() {
  redirect("/admin/pbx");
}
