export type FAQSource = "facebook";
export type FAQStatus = "pending";

export interface FacebookInboxMessage {
  conversationId: string;
  messageId: string;
  text: string;
  senderId?: string;
  senderName?: string;
  timestamp: string;
}

export interface FAQItem {
  question: string;
  answer: string;
  category: string;
  frequency: number;
  source: FAQSource;
  status: FAQStatus;
  updated_at: string;
}

export interface FAQWriteStats {
  created: number;
  updated: number;
}
