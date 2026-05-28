import { type messagingApi } from "@line/bot-sdk";

type FlexMessage = messagingApi.FlexMessage;

export function courseCard(options: {
  title: string;
  description: string;
  price?: string;
  actionLabel?: string;
  actionText?: string;
}): FlexMessage {
  return {
    type: "flex",
    altText: options.title,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: options.title,
            weight: "bold",
            size: "xl",
            color: "#18231F",
            wrap: true,
          },
          {
            type: "text",
            text: options.description,
            size: "sm",
            color: "#1B2221",
            wrap: true,
          },
          ...(options.price
            ? [
                {
                  type: "text" as const,
                  text: options.price,
                  size: "md" as const,
                  color: "#F6B84B",
                  weight: "bold" as const,
                  wrap: true,
                },
              ]
            : []),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#FF7A3D",
            action: {
              type: "message",
              label: options.actionLabel || "สนใจสมัคร",
              text: options.actionText || "สนใจสมัครเรียนค่ะ",
            },
          },
        ],
      },
    },
  };
}

export function serviceMenuCard(
  items: { label: string; question: string }[],
): FlexMessage {
  return {
    type: "flex",
    altText: "เมนูบริการ a/TPK",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "a/TPK ช่วยเรื่องไหนได้บ้าง",
            weight: "bold",
            size: "lg",
            color: "#FFF8E8",
            wrap: true,
          },
        ],
        backgroundColor: "#18231F",
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: items.slice(0, 5).map((item) => ({
          type: "button",
          style: "secondary",
          action: {
            type: "message",
            label: item.label,
            text: item.question,
          },
        })),
      },
    },
  };
}

export function contactCard(options: {
  title?: string;
  description: string;
  actionText?: string;
}): FlexMessage {
  return {
    type: "flex",
    altText: options.title || "ติดต่อทีมงาน a/TPK",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: options.title || "ติดต่อทีมงาน a/TPK",
            weight: "bold",
            size: "xl",
            color: "#18231F",
            wrap: true,
          },
          {
            type: "text",
            text: options.description,
            size: "sm",
            color: "#1B2221",
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#F6B84B",
            action: {
              type: "message",
              label: "ขอแอดมิน",
              text: options.actionText || "ขอแอดมินติดต่อกลับค่ะ",
            },
          },
        ],
      },
    },
  };
}
