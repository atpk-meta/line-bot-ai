import { NextResponse } from "next/server";
import { fetchHumanReplyPairs } from "@/lib/facebook";
import { createFAQDraftsFromPairs } from "@/lib/human-faq";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 30;

function isAuthorized(request: Request): boolean {
  const syncSecret = process.env.SYNC_SECRET;
  if (!syncSecret) {
    return true;
  }

  return request.headers.get("x-sync-secret") === syncSecret;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    log.warn("human_faq.sync_unauthorized");
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const pairs = await fetchHumanReplyPairs();
    const stats = await createFAQDraftsFromPairs(pairs);

    return NextResponse.json({
      success: true,
      ...stats,
    });
  } catch (error) {
    log.error("human_faq.sync_failed", {
      err: error instanceof Error ? error.message : "unknown",
    });

    return NextResponse.json(
      {
        success: false,
        error: "Human reply FAQ sync failed",
      },
      { status: 500 },
    );
  }
}
