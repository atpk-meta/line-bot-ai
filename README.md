# line-bot-ai

Production-grade LINE Bot for a/TPK using Next.js 14, LINE Messaging API, Gemini, and FAQ data from a public Google Sheet CSV.

## Required Environment Variables

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GEMINI_API_KEY`
- `SHEET_CSV_URL`
- `KNOWLEDGE_DOC_URL` optional Google Docs URL used after FAQ priority
- `KNOWLEDGE_TEXT` optional fallback knowledge if `KNOWLEDGE_DOC_URL` is not set or fetch fails
- `ADMIN_GROUP_ID` optional for Smart Handoff notifications
- `ADMIN_LINE_USER_IDS` optional comma-separated LINE user IDs allowed to send `/bot on` and `/bot off`
- `FACEBOOK_PAGE_ID` required for syncing human replies into FAQ drafts
- `FACEBOOK_PAGE_ACCESS_TOKEN` required for syncing Facebook conversations
- `FB_PAGE_ID` optional alias for `FACEBOOK_PAGE_ID`
- `FB_PAGE_ACCESS_TOKEN` optional alias for `FACEBOOK_PAGE_ACCESS_TOKEN`
- `FB_VERIFY_TOKEN` required for Facebook Messenger webhook verification
- `GOOGLE_SERVICE_ACCOUNT_JSON` required to write `FAQ_DRAFT` rows to Google Sheets
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` optional service account email for FAQ sync
- `GOOGLE_PRIVATE_KEY` optional service account private key for FAQ sync
- `GOOGLE_SHEET_ID` optional if it cannot be parsed from `SHEET_CSV_URL`
- `SYNC_SECRET` optional; when set, call sync endpoint with `x-sync-secret`

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

Facebook Messenger webhook URL:

```text
https://YOUR_DOMAIN/api/facebook-webhook
```

Human reply FAQ sync endpoint:

```text
POST https://YOUR_DOMAIN/api/sync-human-replies-to-faq
```

The sync endpoint creates `FAQ_DRAFT` rows with `status=pending`. The LINE bot only uses rows with `status=approved` when a status column exists.

Facebook Inbox FAQ generator:

```text
POST https://YOUR_DOMAIN/api/sync-facebook-faq
```

This endpoint fetches new Facebook customer messages, clusters common questions, and appends pending FAQ drafts to the `FAQ` sheet.

Human handoff behavior:

- Bot fallback pauses that user for 3 hours.
- Human/admin reply pauses that user or Facebook conversation for 6 hours.
- `/bot on` resumes bot replies for that LINE source.
- `/bot off` pauses bot replies for that LINE source.

Optional rich menu install after creating `rich-menu.jpg`:

```bash
npm run rich-menu:install
```
