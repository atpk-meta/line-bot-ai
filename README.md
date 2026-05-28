# line-bot-ai

Production-grade LINE Bot for a/TPK using Next.js 14, LINE Messaging API, Gemini, and FAQ data from a public Google Sheet CSV.

## Required Environment Variables

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GEMINI_API_KEY`
- `SHEET_CSV_URL`
- `ADMIN_GROUP_ID` optional for Smart Handoff notifications
- `KNOWLEDGE_TEXT` optional extra knowledge used only when FAQ has no answer

## Commands

```bash
npm install
npm run lint
npm run build
```

Webhook URL:

```text
https://YOUR_DOMAIN/api/line-webhook
```

Optional rich menu install after creating `rich-menu.jpg`:

```bash
npm run rich-menu:install
```
