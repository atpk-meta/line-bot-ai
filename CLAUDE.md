# CLAUDE.md - LINE Bot AI Project

## What We're Building

LINE Official Account bot for a/TPK. The bot replies to customers 24/7 using Gemini and FAQ data from a public Google Sheet CSV.

The bot persona is "น้องลี่จิน", the personal assistant for คุณเอ / ฐาปกรณ์ ก้อนทองคำ, owner of a/TPK.

## Stack - Locked

- Next.js 14 App Router + TypeScript
- `@line/bot-sdk` for LINE Messaging API
- `@google/genai` for Gemini
- Google Sheet CSV public URL for FAQ
- Vercel for hosting
- npm

## Repo Conventions

- `app/api/line-webhook/route.ts` - POST handler: verify signature, process text events, reply to LINE
- `lib/sheet.ts` - fetch + cache FAQ CSV
- `lib/gemini.ts` - call Gemini with production guardrails
- `lib/handoff.ts` - Smart Handoff trigger detection and admin notification
- `lib/flex-cards.ts` - optional Flex Message builders
- `lib/log.ts` - structured logging helper

## Env Vars

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GEMINI_API_KEY`
- `SHEET_CSV_URL`
- `KNOWLEDGE_DOC_URL` optional Google Docs URL used after FAQ priority
- `KNOWLEDGE_TEXT` optional fallback knowledge if `KNOWLEDGE_DOC_URL` is not set or fetch fails
- `ADMIN_GROUP_ID` optional, for Smart Handoff admin notifications

## Non-Negotiables

- Do not hardcode tokens or API keys.
- Do not skip LINE signature verification.
- Do not expose server env vars to client-side code.
- Do not reduce Gemini temperature below `1.0`.
- Do not set Gemini `maxOutputTokens` below `1024`.
- Do not cache FAQ longer than 60 seconds.
- Do not send partial Gemini output when `finishReason === "MAX_TOKENS"`.
- Do not log full customer message content in normal webhook logs.

## Brand Voice

น้องลี่จิน replies in Thai, short and natural, polite but friendly, calls customers "คุณ", and ends with "ค่ะ" or "นะคะ".

Default fallback:

```text
ขออนุญาตเช็กข้อมูลให้ก่อนนะคะ เดี๋ยวน้องแจ้งคุณเอให้ค่ะ 😊
```
