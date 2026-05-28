import { createHash } from "crypto";
import { type Client } from "@line/bot-sdk";
import { HANDOFF_REPLY } from "./constants";
import { log } from "./log";

const HANDOFF_TRIGGERS = [
  "คุยกับคน",
  "ขอแอดมิน",
  "แอดมิน",
  "ขอเจ้าของ",
  "ติดต่อคุณเอ",
  "ติดต่อทีมงาน",
  "ขอเบอร์",
  "โทรหา",
  "วิทยากร",
  "จ้างสอน",
  "จ้างบรรยาย",
  "ทำคอร์สองค์กร",
  "สปอนเซอร์",
  "collab",
  "pr",
  "media",
  "interview",
  "สัมภาษณ์",
  "ร้องเรียน",
  "ไม่พอใจ",
  "refund",
  "คืนเงิน",
  "ปัญหาการชำระเงิน",
];

export function shouldHandoff(message: string): boolean {
  const lower = message.toLowerCase();
  return HANDOFF_TRIGGERS.some((trigger) => lower.includes(trigger));
}

export function maskLineUserId(userId?: string): string {
  if (!userId) {
    return "unknown";
  }

  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

export async function notifyAdmin(
  client: Client,
  userId: string | undefined,
  userMessage: string,
) {
  const adminGroupId = process.env.ADMIN_GROUP_ID;
  if (!adminGroupId) {
    log.warn("handoff.admin_group_missing", {
      userHash: maskLineUserId(userId),
    });
    return;
  }

  await client.pushMessage(adminGroupId, {
    type: "text",
    text: [
      "มีลูกค้าต้องการคุยกับแอดมินค่ะ",
      "",
      `UserID: ${userId || "unknown"}`,
      `ข้อความ: ${userMessage}`,
      "",
      "เข้าไปตอบที่ LINE Official Account Manager ได้เลยค่ะ",
    ].join("\n"),
  });
}

export { HANDOFF_REPLY };
