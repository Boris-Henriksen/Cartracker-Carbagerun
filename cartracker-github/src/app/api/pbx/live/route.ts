import { NextResponse } from "next/server";
import { carCallState } from "@/lib/pbx-events";

// Public: only whether the car is on a call, for the badge on the tracking page.
export async function GET() {
  return NextResponse.json({ call: carCallState() });
}
